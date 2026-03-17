/**
 * update_daily.js
 * 将解析后的备考数据写入每日记录，并更新统计缓存。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.openclaw/skills/kaogong-study-tracker/data'
);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 写入每日记录
 * @param {ParsedInput} parsed  来自 parse_input.js 的解析结果
 * @param {string} note         可选备注
 */
function updateDailyRecord(parsed, note = '') {
  ensureDir(path.join(DATA_DIR, 'daily'));

  const filePath = path.join(DATA_DIR, 'daily', `${parsed.date}.json`);

  // 如果当天已有记录，合并而非覆盖
  let existing = {};
  if (fs.existsSync(filePath)) {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  const record = {
    date: parsed.date,
    skipped: parsed.skip_today,
    modules: {},
    ...existing,
    mood: parsed.mood,
    note: note || parsed.raw_message.slice(0, 100),
    updated_at: new Date().toISOString(),
  };

  // 合并模块数据
  for (const [mod, data] of Object.entries(parsed.parsed_modules)) {
    record.modules[mod] = {
      ...record.modules[mod],
      ...data,
    };
  }

  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  console.log(`[kaogong-tracker] 每日记录已写入: ${filePath}`);

  // 更新统计缓存
  updateStatsCache(parsed.date, record);

  return record;
}

/**
 * 更新统计缓存（连续打卡天数、模块准确率）
 */
function updateStatsCache(today, todayRecord) {
  const cachePath = path.join(DATA_DIR, 'stats_cache.json');

  let cache = {
    last_updated: today,
    total_days_studied: 0,
    streak: 0,
    module_accuracy: {},
  };
  if (fs.existsSync(cachePath)) {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }

  // 统计连续打卡
  if (!todayRecord.skipped) {
    cache.total_days_studied = (cache.total_days_studied || 0) + 1;

    // 简单连续天数计算：如果昨天有记录则 +1，否则重置为 1
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yPath = path.join(DATA_DIR, 'daily', `${yesterday.toISOString().slice(0,10)}.json`);
    if (fs.existsSync(yPath)) {
      cache.streak = (cache.streak || 0) + 1;
    } else {
      cache.streak = 1;
    }
  }

  // 更新模块准确率（7日滚动平均）
  const last7 = getLast7Days(today);
  const moduleStats = {};

  for (const dateStr of last7) {
    const p = path.join(DATA_DIR, 'daily', `${dateStr}.json`);
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    for (const [mod, info] of Object.entries(d.modules || {})) {
      if (!moduleStats[mod]) moduleStats[mod] = { wrong: 0, total: 0 };
      if (info.wrong != null) {
        moduleStats[mod].wrong += info.wrong;
        // 用标准题数作为 total 估算（如没有精确 total）
        const DEFAULT_TOTALS = { '言语理解': 40, '数量关系': 15, '判断推理': 40, '资料分析': 20 };
        moduleStats[mod].total += info.total || DEFAULT_TOTALS[mod] || 20;
      }
    }
  }

  cache.module_accuracy = {};
  for (const [mod, s] of Object.entries(moduleStats)) {
    if (s.total > 0) {
      cache.module_accuracy[mod] = parseFloat(((s.total - s.wrong) / s.total).toFixed(2));
    }
  }

  // 找出弱项（准确率 < 0.70）
  cache.weak_modules = Object.entries(cache.module_accuracy)
    .filter(([, acc]) => acc < 0.70)
    .sort(([, a], [, b]) => a - b)
    .map(([mod]) => mod);

  cache.last_updated = today;
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  return cache;
}

function getLast7Days(today) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * 读取统计缓存（供回复生成使用）
 */
function readStatsCache() {
  const cachePath = path.join(DATA_DIR, 'stats_cache.json');
  if (!fs.existsSync(cachePath)) return null;
  return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
}

module.exports = { updateDailyRecord, readStatsCache };
