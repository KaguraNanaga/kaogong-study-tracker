/**
 * review_reminder.js
 * 隔天 20:00 由 cron 触发，从"待二刷"错题里随机抽3道，
 * 发给用户让其自评"记得 / 不记得"，连续答对2次自动改为"已掌握"。
 *
 * workspace.yaml 配置（见 assets/workspace-example.yaml）：
 *   cron: 0 20 每隔一天 * *  即  "0 20 1-31/2 * *"
 *   script: skills/kaogong-study-tracker/scripts/review_reminder.js
 *
 * 状态文件：data/review_state.json
 *   记录每道题的二刷历史，key 为题目 id。
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR    = path.join(os.homedir(), '.openclaw/skills/kaogong-study-tracker/data');
const WQ_PATH     = path.join(DATA_DIR, 'wrong_questions.json');
const STATE_PATH  = path.join(DATA_DIR, 'review_state.json');
const SESSION_PATH = path.join(DATA_DIR, 'review_session.json');

// ─── 工具函数 ─────────────────────────────────────────────────

function loadJson(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return fallback; }
}

function saveJson(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── 抽题逻辑 ─────────────────────────────────────────────────

/**
 * 从待二刷错题里随机抽 n 道，优先抽最久没复习的。
 */
function pickQuestions(n = 3) {
  if (!fs.existsSync(WQ_PATH)) return [];

  const questions = loadJson(WQ_PATH, []);
  const state     = loadJson(STATE_PATH, {});

  const pending = questions.filter(q => q.status !== '已掌握');
  if (!pending.length) return [];

  // 按上次复习时间升序（最久没看的排前面）
  pending.sort((a, b) => {
    const ta = state[a.id]?.last_reviewed ?? '2000-01-01';
    const tb = state[b.id]?.last_reviewed ?? '2000-01-01';
    return ta.localeCompare(tb);
  });

  // 取前 n*2 道里随机抽 n 道，避免总是同一批
  const pool   = pending.slice(0, Math.min(n * 2, pending.length));
  const picked = [];
  const used   = new Set();
  while (picked.length < n && picked.length < pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    if (!used.has(idx)) { used.add(idx); picked.push(pool[idx]); }
  }

  return picked;
}

/**
 * 把一道错题格式化成发给用户的文字。
 */
function formatQuestion(q) {
  const lines = [`[${q.module} · ${q.subtype || ''}]`];
  if (q.question_text) lines.push(q.question_text.slice(0, 200));
  if (q.visual_description) lines.push(`图形描述：${q.visual_description.slice(0, 150)}`);
  if (q.answer) lines.push(`正确答案：${q.answer}`);
  lines.push(`知识点：${(q.keywords || []).join('、') || '未标记'}`);
  return lines.join('\n');
}

// ─── 主推送（cron 触发） ──────────────────────────────────────

function buildReminderMessage() {
  const questions = pickQuestions(3);

  if (!questions.length) {
    return '待二刷的错题都清空了，今天不用复习！去刷新题吧。';
  }

  // 把本次抽到的题存入 session，等用户逐一回复
  const session = {
    date:       new Date().toISOString().slice(0, 10),
    questions:  questions.map(q => q.id),
    current:    0,           // 当前正在回答第几道（0-based）
    answers:    {},          // { id: ['记得', '不记得', ...] }
  };
  saveJson(SESSION_PATH, session);

  // 先发第一道
  const first = questions[0];
  return [
    `二刷时间到，抽到 ${questions.length} 道待复习的题。`,
    '',
    `第 1 / ${questions.length} 道：`,
    formatQuestion(first),
    '',
    '还记得这题的解法吗？回复 记得 或 不记得',
  ].join('\n');
}

// ─── 处理用户回复（在 parse_input.js 的 handleMessage 里调用） ──

/**
 * 检测是否有进行中的二刷 session，并处理用户的"记得/不记得"回复。
 * @returns {string|null} 要发送的下一条消息，null 表示没有进行中的 session
 */
function handleReviewReply(userText) {
  if (!fs.existsSync(SESSION_PATH)) return null;

  const session   = loadJson(SESSION_PATH, null);
  if (!session || session.current >= session.questions.length) return null;

  const text      = (userText || '').trim();
  const isRemember = /记得|会了|掌握|对|知道/.test(text);
  const isForget   = /不记得|忘了|不会|错了|不对|不知道/.test(text);

  if (!isRemember && !isForget) return null;  // 不是对二刷的回复

  const currentId = session.questions[session.current];
  if (!session.answers[currentId]) session.answers[currentId] = [];
  session.answers[currentId].push(isRemember ? '记得' : '不记得');

  // 更新 review_state
  const state = loadJson(STATE_PATH, {});
  if (!state[currentId]) state[currentId] = { correct_streak: 0, total: 0 };
  state[currentId].last_reviewed = new Date().toISOString().slice(0, 10);
  state[currentId].total += 1;
  if (isRemember) {
    state[currentId].correct_streak = (state[currentId].correct_streak || 0) + 1;
  } else {
    state[currentId].correct_streak = 0;
  }
  saveJson(STATE_PATH, state);

  // 连续答对 2 次 → 自动标记已掌握
  const mastered = state[currentId].correct_streak >= 2;
  if (mastered) {
    markMastered(currentId);
  }

  // 移到下一题
  session.current += 1;
  saveJson(SESSION_PATH, session);

  // 生成反馈 + 下一题（或结束）
  const feedback = mastered
    ? `已标记为「已掌握」，很好！`
    : isRemember
      ? `记录了。再答对一次就标为已掌握。`
      : `记下了，下次还会再抽到这道。`;

  if (session.current >= session.questions.length) {
    // 全部回答完
    const allQuestions = loadJson(WQ_PATH, []);
    const remaining    = allQuestions.filter(q => q.status !== '已掌握').length;
    return `${feedback}\n\n本次复习完成！还剩 ${remaining} 道待二刷。`;
  }

  // 下一道题
  const nextId = session.questions[session.current];
  const allQ   = loadJson(WQ_PATH, []);
  const nextQ  = allQ.find(q => q.id === nextId);
  if (!nextQ) return `${feedback}\n\n（下一道题找不到了，本次复习结束）`;

  return [
    feedback,
    '',
    `第 ${session.current + 1} / ${session.questions.length} 道：`,
    formatQuestion(nextQ),
    '',
    '还记得这题的解法吗？回复 记得 或 不记得',
  ].join('\n');
}

function markMastered(id) {
  if (!fs.existsSync(WQ_PATH)) return;
  const questions = loadJson(WQ_PATH, []);
  const q = questions.find(q => q.id === id);
  if (q) q.status = '已掌握';
  saveJson(WQ_PATH, questions);
}

// ─── CLI 入口（cron 直接运行） ────────────────────────────────

if (require.main === module) {
  const msg = buildReminderMessage();
  console.log(msg);
}

module.exports = { buildReminderMessage, handleReviewReply };
