/**
 * export_xlsx.js
 * 导出错题本为 .xlsx，支持筛选和截图嵌入。实际写表由 xlsx_writer.py（openpyxl）完成。
 *
 * 依赖：Python 3 + openpyxl + Pillow     pip install openpyxl pillow
 *   找不到 Python 时可以设置 KAOGONG_PYTHON 指向解释器，例如
 *   KAOGONG_PYTHON="C:\Python312\python.exe"
 *
 * 筛选参数：
 *   --pending-only          只导出"待二刷"
 *   --module=判断推理        只导出某科目
 *   --days=30               只导出最近 N 天
 *   --no-images             不嵌入截图
 */

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execFile } = require('child_process');
const { getDataDir } = require('./paths');
const { todayLocal, nowHHMM, addDays, readJson, decodeImage } = require('./util');

const DATA_DIR  = getDataDir();
const OUT_DIR   = path.join(DATA_DIR, 'exports');
const WQ_PATH   = path.join(DATA_DIR, 'wrong_questions.json');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const WRITER_PY = path.join(__dirname, 'xlsx_writer.py');

// ─── 找 Python ────────────────────────────────────────────────
// Windows 上常见坑：没装 Python 时 python3 / python 是微软商店的占位程序，
// 不会报 ENOENT，而是退出码 9009 并打印 "Python was not found"。
// 所以这里把这种情况也当成"没找到"，继续试下一个。

function pythonCandidates() {
  if (process.env.KAOGONG_PYTHON) return [[process.env.KAOGONG_PYTHON, []]];
  return process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
}

function looksMissing(err, stderr) {
  return err && (err.code === 'ENOENT' || err.code === 9009 ||
    /Python was not found|not recognized as an internal|找不到 Python/i.test(stderr || ''));
}

function runPython(args, timeout = 120_000) {
  const candidates = pythonCandidates();
  return new Promise((resolve, reject) => {
    const tryAt = i => {
      if (i >= candidates.length) {
        return reject(new Error('找不到 Python 3。请安装 Python 3（Windows 安装时勾选 "Add to PATH"），或设置环境变量 KAOGONG_PYTHON 指向 python 可执行文件。'));
      }
      const [cmd, pre] = candidates[i];
      execFile(cmd, [...pre, ...args], { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (looksMissing(err, stderr)) return tryAt(i + 1);
          if (err) return reject(translatePyError(err, stderr, cmd));
          resolve({ stdout, stderr });
        });
    };
    tryAt(0);
  });
}

function translatePyError(err, stderr, cmd) {
  if (/KAOGONG_ERR:missing_openpyxl/.test(stderr)) {
    return new Error(`当前 Python（${cmd}）没有安装 openpyxl。运行：${cmd} -m pip install openpyxl pillow`);
  }
  if (/KAOGONG_ERR:file_locked/.test(stderr)) {
    return new Error('导出文件被占用（可能正在 Excel 里打开），关掉后重试。');
  }
  if (err.killed) return new Error('导出超时，错题太多时可以加 --no-images 或按时间筛选。');
  return new Error(`Python 导出失败：${(stderr || err.message).trim().split('\n').slice(-3).join(' | ')}`);
}

// ─── 数据 ─────────────────────────────────────────────────────

function loadDailyRecords() {
  if (!fs.existsSync(DAILY_DIR)) return [];
  return fs.readdirSync(DAILY_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse()
    .map(f => { try { return readJson(path.join(DAILY_DIR, f), null); } catch (_) { return null; } })
    .filter(Boolean);
}

const XINGCE = ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];

function toDailyRow(r) {
  const m = r.modules ?? {};
  const totalWrong = XINGCE.reduce((s, mod) => s + (m[mod]?.wrong ?? 0), 0);
  const shenlun = m['申论'] ? (m['申论'].written ? '是' : '否') : '';
  const multi = XINGCE.filter(mod => (m[mod]?.sets?.length || 0) > 1)
    .map(mod => `${mod.slice(0, 2)}${m[mod].sets.length}套`);
  return [
    r.date ?? '',
    r.skipped ? '休息' : '打卡',
    r.mood ?? '',
    ...XINGCE.map(mod => m[mod]?.wrong ?? ''),
    shenlun,
    totalWrong || '',
    [multi.length ? `[${multi.join(' ')}]` : '', r.note ?? ''].filter(Boolean).join(' '),
  ];
}

function toWrongRow(q) {
  return [
    q.date ?? '',
    q.module ?? '',
    q.subtype ?? '',
    q.error_reason ?? '',
    q.question_text ?? q.question_desc ?? '',
    q.visual_description ?? '',
    q.answer ?? '',
    q.analysis ?? q.user_annotation ?? '',
    Array.isArray(q.keywords) ? q.keywords.join('、') : '',
    q.status ?? '待二刷',
    q.source === 'image' ? '截图' : q.source === 'quick' ? '快捷' : '文字',
    '',
  ];
}

// ─── 主流程 ───────────────────────────────────────────────────

async function exportXlsx({ pendingOnly = false, moduleFilter = null, daysFilter = null, withImages = true } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const questions = readJson(WQ_PATH, []);
  const cutoff    = daysFilter ? addDays(todayLocal(), -(daysFilter - 1)) : null;

  const filtered = questions
    .filter(q => !(pendingOnly && q.status === '已掌握'))
    .filter(q => !(moduleFilter && q.module !== moduleFilter))
    .filter(q => !(cutoff && (q.date ?? '') < cutoff))
    .sort((a, b) => `${b.date}${b.id}`.localeCompare(`${a.date}${a.id}`));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaogong-export-'));
  const images = {};
  const badImages = [];

  try {
    if (withImages) {
      filtered.forEach((q, idx) => {
        if (!q.raw_image_b64) return;
        const img = decodeImage(q.raw_image_b64);
        if (!img) { badImages.push(idx); return; }
        const p = path.join(tmpDir, `q${idx}.${img.ext}`);
        fs.writeFileSync(p, img.buf);
        images[String(idx)] = p;
      });
    }

    const parts = [];
    if (pendingOnly)  parts.push('待二刷');
    if (moduleFilter) parts.push(moduleFilter);
    if (daysFilter)   parts.push(`近${daysFilter}天`);
    // 文件名带时分：同一天多次导出不会撞上"上一个文件还开在 Excel 里"
    const outPath = path.join(OUT_DIR, `备考记录_${todayLocal()}_${nowHHMM()}${parts.length ? '_' + parts.join('_') : ''}.xlsx`);

    const payloadPath = path.join(tmpDir, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify({
      out_path:   outPath,
      sheet_name: pendingOnly ? '待二刷错题' : '错题本',
      wrong_rows: filtered.map(toWrongRow),
      daily_rows: loadDailyRecords().map(toDailyRow),
      images,
      bad_images: badImages,
    }), 'utf-8');

    const { stdout } = await runPython([WRITER_PY, payloadPath]);
    const result = JSON.parse(stdout.trim().split('\n').pop());

    const pending = questions.filter(q => q.status !== '已掌握').length;
    console.log(`[export] 已导出：${outPath}`);
    console.log(`[export] 本次 ${filtered.length} 条（全部 ${questions.length} 条，待二刷 ${pending} 条），截图嵌入 ${result.img_ok} 张`);
    if (!result.has_pil && Object.keys(images).length) {
      console.log('[export] 提示：没有安装 Pillow，截图没有嵌入。运行 pip install pillow 后重新导出。');
    }
    if (result.img_fail || badImages.length) {
      console.log(`[export] 有 ${result.img_fail + badImages.length} 张截图无法读取，已在对应行标注。`);
    }
    console.log(`ATTACH:${outPath}`);
    return outPath;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get  = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  exportXlsx({
    pendingOnly:  argv.includes('--pending-only'),
    withImages:   !argv.includes('--no-images'),
    moduleFilter: get('module') || null,
    daysFilter:   parseInt(get('days'), 10) || null,
  }).catch(e => {
    console.error(`[export] 失败：${e.message}`);
    process.exit(1);
  });
}

module.exports = { exportXlsx };
