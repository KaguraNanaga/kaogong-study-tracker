/**
 * daily_summary.js
 * 定时任务脚本（每天 21:00 由 OpenClaw cron 触发）。
 * 汇总当日数据，主动推送总结消息。
 * 
 * workspace.yaml 配置示例：
 *   cron_jobs:
 *     - name: "备考晚间总结"
 *       schedule: "0 21 * * *"
 *       action:
 *         type: run_script
 *         script: skills/kaogong-study-tracker/scripts/daily_summary.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.openclaw/skills/kaogong-study-tracker/data'
);

function buildSummaryMessage() {
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = path.join(DATA_DIR, 'daily', `${today}.json`);
  const cachePath = path.join(DATA_DIR, 'stats_cache.json');

  // 今天没有记录
  if (!fs.existsSync(dailyPath)) {
    return `今天还没打卡，要发一下今天的题目情况吗？（发"跳过"可以记录休息）`;
  }

  const daily = JSON.parse(fs.readFileSync(dailyPath, 'utf-8'));

  if (daily.skipped) {
    return `今天休息了，记下来了。明天继续 💪`;
  }

  const cache = fs.existsSync(cachePath)
    ? JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    : {};

  const modules = Object.entries(daily.modules || {});
  if (modules.length === 0) {
    return `今天的记录有点简略，有空补充一下各科目错题数吗？`;
  }

  // 找今天最弱模块
  const sortedMods = modules
    .filter(([, v]) => v.wrong != null)
    .sort(([, a], [, b]) => (b.wrong || 0) - (a.wrong || 0));

  const weakestToday = sortedMods[0];
  const streak = cache.streak || 1;

  // 错题分布行
  const modLine = sortedMods
    .map(([mod, v]) => `${mod} ${v.wrong}错`)
    .join(' / ');

  // 连续打卡
  const streakLine = streak >= 3
    ? `连续打卡第 ${streak} 天 🔥`
    : `今天打卡完成 ✅`;

  // 明日建议（基于今天最弱 + 历史弱项）
  const suggestion = buildSuggestion(weakestToday, cache.weak_modules);

  return [
    `今日总结：${modLine}`,
    suggestion,
    streakLine,
  ].join('\n');
}

function buildSuggestion([modName, modData], weakModules) {
  if (!modName) return '';

  const SUGGESTIONS = {
    '判断推理': '判断推理错得多——明天可以专项刷逻辑判断，重点看假言命题。',
    '数量关系': '数量关系是硬伤，明天计时做 10 道工程/行程题，找一找节奏。',
    '资料分析': '资料分析主要看速度，明天练习"先看问题再看材料"的顺序。',
    '言语理解': '言语理解错得多，看看是不是主旨题——这类题有固定解题逻辑。',
    '申论': '申论今天没写——明天哪怕只做一道归纳概括，保持手感。',
  };

  return SUGGESTIONS[modName] || `明天重点看一下【${modName}】，把错题过一遍。`;
}

// 直接运行时，打印消息（OpenClaw 会捕获 stdout 作为推送内容）
const msg = buildSummaryMessage();
console.log(msg);

module.exports = { buildSummaryMessage };
