#!/usr/bin/env node
/**
 * cli.js —— 朱批录的命令行入口。
 * 任何能执行命令的 agent（Claude Code、Codex、Cursor、OpenClaw……）都通过它读写数据，
 * 不需要自己写 JavaScript 胶水代码。除 export 外，所有命令都向 stdout 输出一行 JSON；
 * export 输出几行说明文字，最后一行是 ATTACH:<文件路径>。
 *
 *   node scripts/cli.js welcome                          首次使用时返回欢迎语（之后返回 first_run:false）
 *   node scripts/cli.js log "今天判断推理错了8道"           记录打卡 / 快捷录入错题 / 处理二刷回答
 *                                                        （原话含引号或换行时：echo … | cli.js log -）
 *   node scripts/cli.js add-question --json=q.json --image=截图.png   存一道错题
 *   node scripts/cli.js update-question <id|last> --reason=粗心        补充或修改错题
 *   node scripts/cli.js list-questions --pending --module=判断推理      查错题（找 id 用）
 *   node scripts/cli.js review-reply "不记得"              二刷回答
 *   node scripts/cli.js review                           开始一轮二刷（定时任务用）
 *   node scripts/cli.js stats                            统计数据，回答"哪科最弱"等问题用
 *   node scripts/cli.js summary                          晚间总结文案
 *   node scripts/cli.js export [--pending-only] [--module=…] [--days=N] [--no-images]
 *
 * add-question 的字段（JSON 文件或命令行参数都可以，命令行参数优先）：
 *   module 科目, subtype 题型, question_text 题目文字, visual_description 图形描述,
 *   answer 答案, error_reason 原因（知识点不会/粗心/时间不够/概念混淆，或用户原话）,
 *   keywords 知识点数组, user_annotation 批注, status 待二刷/已掌握
 *   JSON 可以直接用 references/vision_prompt.md 识别出来的结果；--json=- 表示从标准输入读。
 */

const fs   = require('fs');
const path = require('path');

const { getDataDir, getWelcomeFlagPath } = require('./paths');
const { todayLocal, addDays, readJson, decodeImage } = require('./util');
const parse  = require('./parse_input');
const daily  = require('./update_daily');
const review = require('./review_reminder');

const DATA_DIR  = getDataDir();
const WQ_PATH   = path.join(DATA_DIR, 'wrong_questions.json');
const DAILY_DIR = path.join(DATA_DIR, 'daily');

// ─── 参数 ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {}, pos = [];
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=([\s\S]*))?$/);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    else pos.push(a);
  }
  return { flags, pos };
}

const out = obj => { process.stdout.write(JSON.stringify(obj) + '\n'); };

function fail(msg, code = 1) {
  out({ ok: false, error: msg });
  process.exit(code);
}

// ─── 辅助 ─────────────────────────────────────────────────────

function lastStudyDate(before = todayLocal()) {
  if (!fs.existsSync(DAILY_DIR)) return null;
  const dates = fs.readdirSync(DAILY_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.slice(0, 10))
    .filter(d => d <= before && daily.isStudyDay(d))
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function briefQuestion(q) {
  return {
    id: q.id, date: q.date, module: q.module, subtype: q.subtype || '',
    error_reason: q.error_reason || '未说明', status: q.status || '待二刷',
    text: String(q.question_text || q.visual_description || '').replace(/\s+/g, ' ').slice(0, 60),
    has_image: Boolean(q.raw_image_b64),
  };
}

function normalizeReason(r) {
  if (!r) return '未说明';
  if (parse.REASONS.includes(r)) return r;
  return parse.inferErrorReason(String(r));
}

function normalizeStatus(s) {
  if (!s) return null;
  if (/已?掌握|会了|搞懂/.test(s)) return '已掌握';
  if (/待二刷|未掌握|不会|没掌握/.test(s)) return '待二刷';
  return null;
}

function confirmQuestion(q) {
  if (!parse.normalizeModule(q.module || '')) return '这是哪个科目？（常识/言语/数量/判断/资料/申论）';
  if (!parse.REASONS.includes(q.error_reason)) return '这道题是知识点没掌握、粗心、时间不够，还是概念混淆？';
  return null;
}

function resolveId(idArg, questions) {
  if (!idArg) fail('需要题目 id，或用 last 表示最近录入的一道');
  if (idArg === 'last') {
    const q = questions[questions.length - 1];
    if (!q) fail('错题本是空的');
    return q.id;
  }
  if (!questions.some(q => q.id === idArg)) fail(`找不到 id 为 ${idArg} 的错题，可以先 list-questions 查一下`);
  return idArg;
}

// ─── 命令 ─────────────────────────────────────────────────────

const commands = {
  welcome() {
    const flag = getWelcomeFlagPath();
    if (fs.existsSync(flag)) return out({ ok: true, first_run: false });
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, new Date().toISOString());
    out({
      ok: true, first_run: true,
      message: '朱批录已安装。\n\n直接发文字就能记录，比如"今天判断推理错了8道"。\n'
             + '发错题截图我会自动识别归档；当前 agent 看不了图的话，把题目文字复制过来也一样。',
    });
  },

  log({ pos }) {
    // 原话里有引号、换行时，用 log - 从标准输入传，避免命令行转义出错
    const text = (pos[0] === '-' ? fs.readFileSync(0, 'utf-8') : pos.join(' ')).trim();
    if (!text) fail('用法：cli.js log "用户原话"');

    // 二刷进行中时，"记得 / 不记得"优先当作二刷回答
    const reviewMsg = review.handleReviewReply(text);
    if (reviewMsg !== null) return out({ ok: true, type: 'review', message: reviewMsg });

    const exportCmd = parse.parseExportCommand(text);
    if (exportCmd) {
      const args = [
        exportCmd.pendingOnly && '--pending-only',
        exportCmd.moduleFilter && `--module=${exportCmd.moduleFilter}`,
        exportCmd.daysFilter && `--days=${exportCmd.daysFilter}`,
      ].filter(Boolean);
      return out({ ok: true, type: 'export_request', run: `node scripts/cli.js export ${args.join(' ')}`.trim() });
    }

    const parsed = parse.parseStudyInput(text);

    if (parsed.source === 'quick') {
      const { needs_confirm, ...q } = parsed;
      const list = daily.saveWrongQuestion(q);
      const saved = list[list.length - 1];
      return out({ ok: true, type: 'question_saved', question: briefQuestion(saved), total_questions: list.length });
    }

    const hasModules = Object.keys(parsed.parsed_modules).length > 0;
    if (!hasModules && !parsed.skip_today) {
      return out({
        ok: true, type: 'nothing_recorded',
        needs_clarification: parsed.needs_clarification,
        hint: parsed.needs_clarification ? null : '这条消息里没有可记录的成绩，按普通对话回复即可',
      });
    }

    const prevStudy = lastStudyDate(addDays(todayLocal(), -1));
    const record = daily.updateDailyRecord(parsed);
    const stats  = daily.readStatsCache() || {};
    out({
      ok: true,
      type: parsed.skip_today && !hasModules ? 'rest_day' : 'daily_logged',
      date: record.date,
      modules: Object.fromEntries(Object.entries(record.modules).map(([m, v]) =>
        [m, v.written !== undefined ? { written: v.written } : { wrong: v.wrong, total: v.total, sets: v.sets?.length || 1 }])),
      mood: record.mood,
      streak: stats.streak || 0,
      // 上次学习距今天数：> 3 时可以在回复末尾轻轻提一句
      days_since_last_study_before_today: prevStudy ? daysBetween(prevStudy, todayLocal()) : null,
      weak_modules: stats.weak_modules || [],
      needs_clarification: parsed.needs_clarification,
    });
  },

  'add-question'({ flags }) {
    let q = {};
    if (flags.json) {
      const raw = flags.json === '-' || flags.json === true ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(flags.json, 'utf-8');
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      if (s < 0 || e <= s) fail('--json 里没有找到 JSON 对象');
      try { q = JSON.parse(raw.slice(s, e + 1)); } catch (err) { fail(`--json 解析失败：${err.message}`); }
      if (q.error) fail(`识别失败：${q.error}`, 2);
    }
    const map = {
      module: 'module', subtype: 'subtype', text: 'question_text', visual: 'visual_description',
      answer: 'answer', reason: 'error_reason', note: 'user_annotation', status: 'status', date: 'date',
    };
    for (const [flag, field] of Object.entries(map)) if (typeof flags[flag] === 'string') q[field] = flags[flag];
    if (typeof flags.keywords === 'string') q.keywords = flags.keywords.split(/[,，、]/).map(s => s.trim()).filter(Boolean);

    const question = {
      source:             flags.image ? 'image' : 'text',
      date:               /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : todayLocal(),
      module:             parse.normalizeModule(q.module || '') || q.module || null,
      subtype:            q.subtype || '未识别',
      question_text:      q.question_text || '',
      visual_description: q.visual_description || null,
      answer:             q.answer || null,
      user_annotation:    q.user_annotation || null,
      error_reason:       normalizeReason(q.error_reason || q.error_reason_hint),
      keywords:           Array.isArray(q.keywords) ? q.keywords.slice(0, 3) : [],
      status:             normalizeStatus(q.status) || '待二刷',
    };
    if (!question.question_text && !question.visual_description && !flags.image) {
      fail('题目内容为空：至少需要 question_text、visual_description 或 --image 之一');
    }

    const finish = imgB64 => {
      if (imgB64) question.raw_image_b64 = imgB64;
      const list  = daily.saveWrongQuestion(question);
      const saved = list[list.length - 1];
      out({
        ok: true, type: 'question_saved',
        question: briefQuestion(saved),
        total_questions: list.length,
        // 不为 null 时问用户一次，再用 update-question last --reason=… / --module=… 补上
        needs_confirm: flags['no-confirm'] ? null : confirmQuestion(question),
      });
    };

    if (!flags.image) return finish(null);
    if (!fs.existsSync(flags.image)) fail(`找不到图片文件：${flags.image}`);
    const b64 = fs.readFileSync(flags.image).toString('base64');
    if (!decodeImage(b64)) fail('这个文件不是可识别的图片（支持 png / jpg / gif / webp / bmp）');
    parse.compressImageAsync(b64).then(finish).catch(e => fail(e.message));
  },

  'update-question'({ pos, flags }) {
    const questions = readJson(WQ_PATH, []);
    const id = resolveId(pos[0], questions);
    const patch = {};
    if (typeof flags.module === 'string') {
      patch.module = parse.normalizeModule(flags.module);
      if (!patch.module) fail(`无法识别的科目：${flags.module}`);
    }
    if (typeof flags.reason  === 'string') patch.error_reason = normalizeReason(flags.reason);
    if (typeof flags.subtype === 'string') patch.subtype = flags.subtype;
    if (typeof flags.answer  === 'string') patch.answer = flags.answer;
    if (typeof flags.note    === 'string') patch.user_annotation = flags.note;
    if (typeof flags.text    === 'string') patch.question_text = flags.text;
    if (typeof flags.keywords === 'string') patch.keywords = flags.keywords.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    if (typeof flags.status  === 'string') {
      patch.status = normalizeStatus(flags.status);
      if (!patch.status) fail('status 只能是 待二刷 或 已掌握');
    }
    if (!Object.keys(patch).length) fail('没有要修改的字段，例如 --reason=粗心 --status=已掌握');
    const q = daily.updateWrongQuestion(id, patch);
    out({ ok: true, type: 'question_updated', question: briefQuestion(q) });
  },

  'list-questions'({ flags }) {
    let qs = readJson(WQ_PATH, []);
    if (flags.pending) qs = qs.filter(q => q.status !== '已掌握');
    if (typeof flags.module === 'string') {
      const m = parse.normalizeModule(flags.module);
      qs = qs.filter(q => q.module === m);
    }
    if (typeof flags.keyword === 'string') {
      const k = flags.keyword;
      qs = qs.filter(q => [q.question_text, q.visual_description, q.subtype, ...(q.keywords || [])].some(v => String(v || '').includes(k)));
    }
    const limit = parseInt(flags.limit, 10) || 10;
    const total = qs.length;
    qs = qs.sort((a, b) => `${b.date}${b.id}`.localeCompare(`${a.date}${a.id}`)).slice(0, limit);
    out({ ok: true, total, questions: qs.map(briefQuestion) });
  },

  'review-reply'({ pos }) {
    const msg = review.handleReviewReply(pos.join(' '));
    out({ ok: true, handled: msg !== null, message: msg });
  },

  review() {
    out({ ok: true, message: review.buildReminderMessage() });
  },

  stats() {
    const today = todayLocal();
    const cache = daily.updateStatsCache(today);
    const qs    = readJson(WQ_PATH, []);
    const pending = qs.filter(q => q.status !== '已掌握');

    const last7 = {};
    for (let i = 0; i < 7; i++) {
      let rec;
      try { rec = readJson(path.join(DAILY_DIR, `${addDays(today, -i)}.json`), null); } catch (_) { rec = null; }
      for (const [m, v] of Object.entries(rec?.modules || {})) {
        if (v.wrong != null) last7[m] = (last7[m] || 0) + v.wrong;
      }
    }
    const count = (arr, key) => Object.entries(arr.reduce((acc, q) => {
      const k = q[key] || '未说明'; acc[k] = (acc[k] || 0) + 1; return acc;
    }, {})).sort((a, b) => b[1] - a[1]);

    const last = lastStudyDate(today);
    out({
      ok: true,
      today,
      streak: cache.streak,
      total_days_studied: cache.total_days_studied,
      last_study_date: last,
      days_since_last_study: last ? daysBetween(last, today) : null,
      module_accuracy_7d: cache.module_accuracy,
      accuracy_estimated: cache.accuracy_estimated,   // 这些科目的准确率是按默认题量估算的，表述别太肯定
      weak_modules: cache.weak_modules,
      wrong_count_7d: last7,
      questions: { total: qs.length, pending: pending.length, mastered: qs.length - pending.length },
      pending_by_module: count(pending, 'module'),
      pending_by_reason: count(pending, 'error_reason'),
    });
  },

  summary() {
    out({ ok: true, message: require('./daily_summary').buildSummaryMessage() });
  },

  export({ flags }) {
    require('./export_xlsx').exportXlsx({
      pendingOnly:  Boolean(flags['pending-only']),
      withImages:   !flags['no-images'],
      moduleFilter: typeof flags.module === 'string' ? (parse.normalizeModule(flags.module) || flags.module) : null,
      daysFilter:   parseInt(flags.days, 10) || null,
    }).catch(e => { console.error(`[export] 失败：${e.message}`); process.exit(1); });
  },
};

// ─── 入口 ─────────────────────────────────────────────────────

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || !commands[cmd]) {
    fail(`未知命令：${cmd || '（空）'}。可用：${Object.keys(commands).join(' / ')}`);
  }
  try {
    commands[cmd](parseArgs(rest));
  } catch (e) {
    fail(e.message);
  }
}

module.exports = { commands, parseArgs };
