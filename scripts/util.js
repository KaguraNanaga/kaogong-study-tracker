/**
 * util.js
 * 各脚本共用的小工具：本地日期、原子写 JSON、图片 base64 规范化。
 */

const fs   = require('fs');
const path = require('path');

// ─── 日期 ─────────────────────────────────────────────────────
// 不要用 new Date().toISOString().slice(0, 10)：那是 UTC 日期，
// 北京时间 0:00–8:00 之间会得到"昨天"，打卡、连续天数、晚间总结都会错位。

function pad(n) { return String(n).padStart(2, '0'); }

/** 本地日期 YYYY-MM-DD（可用 KAOGONG_TZ 指定时区，如 Asia/Shanghai） */
function todayLocal(date = new Date()) {
  const tz = process.env.KAOGONG_TZ;
  if (tz) {
    // en-CA 的日期格式正好是 YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地时间 HHMM，用于导出文件名 */
function nowHHMM(date = new Date()) {
  return `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** 'YYYY-MM-DD' 加减天数，纯日历运算，不受时区/夏令时影响 */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// ─── JSON 读写 ────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 原子写：先写临时文件再 rename。
 * 写到一半进程被杀（agent 超时很常见）时，原文件不会变成半截 JSON。
 */
function writeJsonAtomic(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

/**
 * 读 JSON。文件不存在 → 返回 fallback；文件存在但损坏 → 抛错。
 * 损坏时绝不能静默返回空数组再写回去，那会把整个错题本覆盖掉。
 */
function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  const raw = fs.readFileSync(p, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${p} 内容损坏，无法解析（${e.message}）。可以从同目录 backups/ 里恢复最近的备份。`);
  }
}

// ─── 图片 base64 ──────────────────────────────────────────────

/**
 * 去掉 data URL 前缀和空白。
 * "data:image/png;base64," 里的字母本身都是合法 base64 字符，
 * 不去掉的话 Buffer.from 会把它们当数据解码，图片直接损坏。
 */
function normalizeBase64(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  return b64.replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '');
}

/** 根据文件头判断图片格式，返回 { ext, mime } 或 null */
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png',  mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8)                                       return { ext: 'jpg',  mime: 'image/jpeg' };
  if (buf.slice(0, 3).toString('ascii') === 'GIF')                              return { ext: 'gif',  mime: 'image/gif' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP')
                                                                                 return { ext: 'webp', mime: 'image/webp' };
  if (buf.slice(0, 2).toString('ascii') === 'BM')                               return { ext: 'bmp',  mime: 'image/bmp' };
  return null;
}

/** base64 → { buf, ext, mime }；无法识别为图片时返回 null */
function decodeImage(b64) {
  const clean = normalizeBase64(b64);
  if (!clean) return null;
  const buf  = Buffer.from(clean, 'base64');
  const type = detectImageType(buf);
  return type ? { buf, ...type } : null;
}

module.exports = {
  todayLocal, nowHHMM, addDays,
  ensureDir, writeJsonAtomic, readJson,
  normalizeBase64, detectImageType, decodeImage,
};
