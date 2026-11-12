/**
 * review_reminder.js
 * 隔天由 cron 触发，从"待二刷"错题里抽 3 道让用户自评。
 * 连续 2 次"记得"自动改为"已掌握"。
 *
 * cron 示例（每两天 20:00）：0 20 * * 1,3,5,0
 *   （不要用 "1-31/2"：31 号和次月 1 号会连着推两天）
 *
 * 状态文件：
 *   data/review_state.json    每道题的二刷历史
 *   data/review_session.json  当前这轮复习进行到第几题
 */

const fs   = require('fs');
const path = require('path');
const { getDataDir } = require('./paths');
const { todayLocal, readJson, writeJsonAtomic } = require('./util');

const DATA_DIR     = getDataDir();
const WQ_PATH      = path.join(DATA_DIR, 'wrong_questions.json');
const STATE_PATH   = path.join(DATA_DIR, 'review_state.json');
const SESSION_PATH = path.join(DATA_DIR, 'review_session.json');

const SESSION_TTL_MS = 18 * 3600 * 1000;   // 一轮复习超过 18 小时没答完就作废，不再拦截普通消息

function load(p, fb) { try { return readJson(p, fb); } catch (_) { return fb; } }

// ─── 抽题 ─────────────────────────────────────────────────────

function pickQuestions(n = 3) {
  const pending = load(WQ_PATH, []).filter(q => q.status !== '已掌握');
  if (!pending.length) return [];
  const state = load(STATE_PATH, {});

  // 最久没复习的优先；从前 2n 道里随机抽 n 道，避免总是同一批
  pending.sort((a, b) =>
    (state[a.id]?.last_reviewed ?? '0000').localeCompare(state[b.id]?.last_reviewed ?? '0000'));
  const pool = pending.slice(0, n * 2);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/** 出题时不显示答案，用户回答后再给答案 */
function formatQuestion(q) {
  const lines = [`[${q.module}${q.subtype ? ' · ' + q.subtype : ''}]  ${q.date || ''}`];
  if (q.question_text)      lines.push(q.question_text.slice(0, 300));
  if (q.visual_description) lines.push(`图形描述：${q.visual_description.slice(0, 200)}`);
  if (!q.question_text && !q.visual_description) lines.push('（这道题没有文字内容，翻一下错题本里的截图）');
  return lines.join('\n');
}

function formatAnswer(q) {
  const parts = [];
  if (q.answer) parts.push(`答案：${q.answer}`);
  if (q.keywords?.length) parts.push(`知识点：${q.keywords.join('、')}`);
  return parts.join('　');
}

const ASK = '先在心里做一遍，再回复「记得」或「不记得」';

// ─── cron 推送 ────────────────────────────────────────────────

function buildReminderMessage() {
  const questions = pickQuestions(3);
  if (!questions.length) {
    try { fs.unlinkSync(SESSION_PATH); } catch (_) {}
    return '待二刷的错题都清空了，今天不用复习！去刷新题吧。';
  }

  writeJsonAtomic(SESSION_PATH, {
    date:       todayLocal(),
    started_at: Date.now(),
    questions:  questions.map(q => q.id),
    current:    0,
  });

  return [
    `二刷时间到，抽到 ${questions.length} 道待复习的题。`,
    '',
    `第 1 / ${questions.length} 道：`,
    formatQuestion(questions[0]),
    '',
    ASK,
  ].join('\n');
}

// ─── 处理回复 ─────────────────────────────────────────────────

/**
 * 判断用户回复是"记得"还是"不记得"。
 * 必须先判断否定：原来先测 /记得/，"不记得"里也含"记得"，于是所有"不记得"都被记成"记得"，
 * 两次之后错题被自动标为已掌握。"不知道"/"不对" 同理。
 * 另外只接受短回复，"对了，今天判断错了8道"这种正常消息不能被当成二刷回答吞掉。
 */
function classifyReply(text) {
  const t = (text || '').trim().replace(/[。！!，,.~～\s]/g, '');
  if (!t || t.length > 8) return null;
  if (/不记得|忘了|忘记|不会|不知道|不对|错了|没印象|记不清|不太记得/.test(t)) return 'forget';
  if (/^(记得|会了|会|掌握了|知道|对的?|做对了|记住了|没问题|还记得|记得的)$/.test(t)) return 'remember';
  return null;
}

function handleReviewReply(userText) {
  const session = load(SESSION_PATH, null);
  if (!session || session.current >= session.questions.length) return null;
  if (Date.now() - (session.started_at || 0) > SESSION_TTL_MS) {
    try { fs.unlinkSync(SESSION_PATH); } catch (_) {}
    return null;
  }

  const verdict = classifyReply(userText);
  if (!verdict) return null;

  const all       = load(WQ_PATH, []);
  const currentId = session.questions[session.current];
  const currentQ  = all.find(q => q.id === currentId);

  const state = load(STATE_PATH, {});
  const st    = state[currentId] || { correct_streak: 0, total: 0, history: [] };
  st.last_reviewed  = todayLocal();
  st.total         += 1;
  st.correct_streak = verdict === 'remember' ? (st.correct_streak || 0) + 1 : 0;
  st.history        = [...(st.history || []), { date: st.last_reviewed, result: verdict }].slice(-10);
  state[currentId]  = st;
  writeJsonAtomic(STATE_PATH, state);

  const mastered = st.correct_streak >= 2;
  if (mastered && currentQ) {
    currentQ.status = '已掌握';
    writeJsonAtomic(WQ_PATH, all);
  }

  const answer   = currentQ ? formatAnswer(currentQ) : '';
  const feedback = [
    mastered ? '连续两次记得，已标记为「已掌握」。'
      : verdict === 'remember' ? '好，再记得一次就标为已掌握。'
      : '记下了，下次还会抽到它。',
    answer,
  ].filter(Boolean).join('\n');

  session.current += 1;
  // 跳过已经被删掉的题
  while (session.current < session.questions.length &&
         !all.find(q => q.id === session.questions[session.current])) {
    session.current += 1;
  }

  if (session.current >= session.questions.length) {
    try { fs.unlinkSync(SESSION_PATH); } catch (_) {}
    const remaining = all.filter(q => q.status !== '已掌握').length;
    return `${feedback}\n\n本次复习完成！还剩 ${remaining} 道待二刷。`;
  }

  writeJsonAtomic(SESSION_PATH, session);
  const nextQ = all.find(q => q.id === session.questions[session.current]);
  return [
    feedback,
    '',
    `第 ${session.current + 1} / ${session.questions.length} 道：`,
    formatQuestion(nextQ),
    '',
    ASK,
  ].join('\n');
}

if (require.main === module) {
  console.log(buildReminderMessage());
}

module.exports = { buildReminderMessage, handleReviewReply, classifyReply };
