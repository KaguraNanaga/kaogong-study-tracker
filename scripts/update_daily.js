/**
 * update_daily.js
 * 将解析后的备考数据写入每日记录，并更新统计缓存。
 */

const fs   = require('fs');
const path = require('path');
const { getDataDir } = require('./paths');
const { todayLocal, addDays, ensureDir, readJson, writeJsonAtomic } = require('./util');

const DATA_DIR  = getDataDir();
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const WQ_PATH   = path.join(DATA_DIR, 'wrong_questions.json');
const MODULE_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/module_map.json'), 'utf-8'));
const DEFAULT_TOTALS = MODULE_MAP.default_totals || {};

// ─── 备份 ─────────────────────────────────────────────────────

/**
 * 每天最多备份一次 wrong_questions.json，保留最近 10 天。
 * 原来每次写入都备份、只留 10 份：一天录 10 道题，前一天的备份就全被挤掉了，
 * 文件一旦损坏几乎无从恢复；而且每份备份都含全部截图，很占空间。
 */
function backupWrongQuestions() {
  if (!fs.existsSync(WQ_PATH)) return;
  const backupDir = path.join(DATA_DIR, 'backups');
  ensureDir(backupDir);

  const dest = path.join(backupDir, `wrong_questions.${todayLocal()}.json`);
  if (!fs.existsSync(dest)) fs.copyFileSync(WQ_PATH, dest);

  fs.readdirSync(backupDir)
    .filter(f => /^wrong_questions\..+\.json$/.test(f))
    .sort().reverse()
    .slice(10)
    .forEach(f => { try { fs.unlinkSync(path.join(backupDir, f)); } catch (_) {} });
}

// ─── 每日记录 ─────────────────────────────────────────────────

/**
 * 同一科目一天内的多次成绩：每次记为一"套"（sets），wrong / total 是各套之和。
 * 旧格式（只有 wrong/total、没有 sets）读进来时当作一套处理。
 */
function setsOf(info = {}) {
  if (Array.isArray(info.sets)) return info.sets;
  return info.wrong != null ? [{ wrong: info.wrong, total: info.total ?? null }] : [];
}

function summarize(sets, extra = {}) {
  const valid = sets.filter(x => x.wrong != null);
  return {
    ...extra,
    wrong: valid.reduce((s, x) => s + x.wrong, 0),
    // 每套都知道总题数时才给出合计，否则留空，统计时按默认题量估算
    total: valid.length && valid.every(x => x.total) ? valid.reduce((s, x) => s + x.total, 0) : null,
    sets,
  };
}

const DUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * 写入每日记录。同一天多条消息的处理规则：
 *   - 同一科目再报一次错题数 → 当作又做了一套，累加
 *   - 消息里有"说错了/更正/改成/应该是"→ 替换该科目最近一套，而不是累加
 *   - 只补了总题数（"判断那套是40道"）→ 补到最近一套上
 *   - 10 分钟内同一句话重复写入（agent 重试）→ 忽略，不重复累加
 *   - 申论只记写没写，写过一次就算写了
 * @param {object} parsed  parse_input.js 的 parseStudyInput 结果
 * @param {string} note    可选备注
 */
function updateDailyRecord(parsed, note = '') {
  ensureDir(DAILY_DIR);
  const date     = parsed.date || todayLocal();
  const filePath = path.join(DAILY_DIR, `${date}.json`);
  const existing = readJson(filePath, {});
  const now      = Date.now();
  const msg      = (parsed.raw_message || '').trim();
  const isFix    = Boolean(parsed.is_correction);

  const modules = { ...(existing.modules || {}) };
  for (const [mod, data] of Object.entries(parsed.parsed_modules || {})) {
    if (mod === '申论') {
      const prev = modules[mod] || {};
      modules[mod] = { written: isFix ? Boolean(data.written) : Boolean(prev.written || data.written) };
      continue;
    }

    const sets = [...setsOf(modules[mod])];
    const last = sets[sets.length - 1];
    const reason = data.error_reason && data.error_reason !== '未说明' ? data.error_reason : undefined;

    if (msg && last && last.msg === msg && now - (last.at || 0) < DUP_WINDOW_MS) continue;   // 重复写入

    if (data.wrong == null) {
      // 没有错题数：只补总题数 / 原因到最近一套
      if (last && data.total && !last.total) last.total = data.total;
      if (last && reason) last.error_reason = reason;
      if (!last) continue;
    } else {
      const entry = { wrong: data.wrong, total: data.total ?? null, at: now, msg: msg.slice(0, 80) };
      if (reason) entry.error_reason = reason;
      if (isFix && sets.length) {
        if (entry.total == null) entry.total = last.total ?? null;   // 只更正错题数时保留原来的总题数
        sets[sets.length - 1] = entry;
      }
      else sets.push(entry);
    }
    modules[mod] = summarize(sets);
  }

  const hasData = Object.keys(modules).length > 0;
  const notes   = [existing.note, note || msg.slice(0, 100)].filter(Boolean);

  const record = {
    date,
    // 当天只要有做题数据就不算休息；后来补一句"今天先休息"不会把已有成绩抹掉
    skipped:    hasData ? false : Boolean(parsed.skip_today || existing.skipped),
    modules,
    mood:       parsed.mood && parsed.mood !== '中性' ? parsed.mood : (existing.mood || parsed.mood || '中性'),
    note:       [...new Set(notes)].join(' / ').slice(0, 300),
    updated_at: new Date(now).toISOString(),
  };

  writeJsonAtomic(filePath, record);
  updateStatsCache(date);
  return record;
}

// ─── 统计 ─────────────────────────────────────────────────────

function isStudyDay(date) {
  const p = path.join(DAILY_DIR, `${date}.json`);
  if (!fs.existsSync(p)) return false;
  try {
    // 必须有做题数据才算学习日；只发了句"好累"之类的空记录不算
    const rec = readJson(p, {});
    return !rec.skipped && Object.keys(rec.modules || {}).length > 0;
  } catch (_) { return false; }
}

/**
 * 统计缓存每次都从 daily/ 目录重新计算，而不是在旧值上 +1。
 * 原来的写法每收到一条消息就 total_days +1、streak +1，一天发三条就算三天。
 */
function updateStatsCache(asOf = todayLocal()) {
  const files = fs.existsSync(DAILY_DIR)
    ? fs.readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];
  const studyDays = files.map(f => f.slice(0, 10)).filter(isStudyDay);

  // 连续打卡：从今天往回数；今天还没打卡就从昨天开始数，不算断
  let streak = 0;
  let d = isStudyDay(asOf) ? asOf : addDays(asOf, -1);
  while (isStudyDay(d)) { streak++; d = addDays(d, -1); }

  // 近 7 日模块准确率
  const stats = {};
  for (let i = 0; i < 7; i++) {
    const p = path.join(DAILY_DIR, `${addDays(asOf, -i)}.json`);
    let rec;
    try { rec = readJson(p, null); } catch (_) { rec = null; }
    if (!rec) continue;
    for (const [mod, info] of Object.entries(rec.modules || {})) {
      for (const set of setsOf(info)) {          // 按套累计，每套缺总题数时单独按默认题量估算
        if (set.wrong == null) continue;
        const total = set.total || DEFAULT_TOTALS[mod];
        if (!total) continue;
        stats[mod] = stats[mod] || { wrong: 0, total: 0, estimated: false };
        stats[mod].wrong += set.wrong;
        stats[mod].total += total;
        if (!set.total) stats[mod].estimated = true;
      }
    }
  }

  const module_accuracy = {};
  for (const [mod, s] of Object.entries(stats)) {
    module_accuracy[mod] = Math.max(0, parseFloat(((s.total - s.wrong) / s.total).toFixed(2)));
  }

  const cache = {
    last_updated:       asOf,
    streak,
    total_days_studied: studyDays.length,
    module_accuracy,
    // 准确率用的是估算总题数时标出来，回复里别说得太肯定
    accuracy_estimated: Object.keys(stats).filter(m => stats[m].estimated),
    weak_modules: Object.entries(module_accuracy)
      .filter(([, acc]) => acc < 0.70)
      .sort(([, a], [, b]) => a - b)
      .map(([mod]) => mod),
  };

  writeJsonAtomic(path.join(DATA_DIR, 'stats_cache.json'), cache);
  return cache;
}

function readStatsCache() {
  return readJson(path.join(DATA_DIR, 'stats_cache.json'), null);
}

// ─── 错题 ─────────────────────────────────────────────────────

/**
 * 追加一条错题。wrong_questions.json 损坏时 readJson 会抛错，
 * 而不是像原来那样当成空数组、再把只有一条的新数组写回去覆盖全部错题。
 */
function saveWrongQuestion(question) {
  ensureDir(DATA_DIR);
  const questions = readJson(WQ_PATH, []);
  backupWrongQuestions();

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { needs_confirm, success, fallback_prompt, ...clean } = question;
  questions.push({ id, status: '待二刷', date: todayLocal(), ...clean });

  writeJsonAtomic(WQ_PATH, questions);
  return questions;   // 新错题在最后一条，id 用于后续追问补充原因：updateWrongQuestion(id, {...})
}

/** 更新某条错题的字段（状态、补充的原因/科目等） */
function updateWrongQuestion(id, patch) {
  const questions = readJson(WQ_PATH, []);
  const q = questions.find(x => x.id === id);
  if (!q) return null;
  backupWrongQuestions();
  Object.assign(q, patch);
  writeJsonAtomic(WQ_PATH, questions);
  return q;
}

function updateWrongQuestionStatus(id, status) {
  return updateWrongQuestion(id, { status });
}

module.exports = {
  isStudyDay,
  setsOf,
  updateDailyRecord, updateStatsCache, readStatsCache,
  saveWrongQuestion, updateWrongQuestion, updateWrongQuestionStatus,
};
