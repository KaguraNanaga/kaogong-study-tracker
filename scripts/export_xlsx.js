/**
 * export_xlsx.js
 * 导出错题本为 .xlsx，支持将截图原图嵌入对应行。
 *
 * 图片嵌入逻辑：
 *   - 错题记录中如果有 raw_image_b64 字段，把图片写成临时文件
 *   - 用 openpyxl（Python）将图片嵌入到对应行的 I 列
 *   - 纯文字题（无图片）该列留空
 *
 * 为什么用 Python 而不是纯 JS：
 *   xlsx (npm) 不支持图片嵌入；openpyxl（Python）原生支持，
 *   且我们已经依赖 Python 环境跑 PaddleOCR，所以不额外增加依赖。
 *
 * 触发方式：用户说"导出错题本" / "把错题发给我" / "生成报告"
 * 用法：node export_xlsx.js [--pending-only] [--with-images]
 */

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { execFile }  = require('child_process');

const DATA_DIR  = path.join(os.homedir(), '.openclaw/skills/kaogong-study-tracker/data');
const OUT_DIR   = path.join(DATA_DIR, 'exports');
const WQ_PATH   = path.join(DATA_DIR, 'wrong_questions.json');
const DAILY_DIR = path.join(DATA_DIR, 'daily');

// ─── Windows 兼容：python3 / python 双 fallback ──────────────

function runPython(args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    function attempt(cmd) {
      execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT' && cmd === 'python3') return attempt('python');
        if (err) return reject({ error: err, stderr });
        resolve({ stdout, stderr });
      });
    }
    attempt('python3');
  });
}

// ─── 数据读取 ─────────────────────────────────────────────────

function loadWrongQuestions() {
  if (!fs.existsSync(WQ_PATH)) return [];
  return JSON.parse(fs.readFileSync(WQ_PATH, 'utf-8'));
}

function loadDailyRecords() {
  if (!fs.existsSync(DAILY_DIR)) return [];
  return fs.readdirSync(DAILY_DIR)
    .filter(f => f.endsWith('.json'))
    .sort().reverse()
    .map(f => JSON.parse(fs.readFileSync(path.join(DAILY_DIR, f), 'utf-8')));
}

// ─── 生成 Python 脚本（动态，含图片路径） ────────────────────

/**
 * 把带图片的错题数据写成一个临时 Python 脚本，让 openpyxl 执行。
 * 动态生成是为了把图片路径直接硬编码进脚本，避免传参过长。
 */
function buildPythonScript({ wrongRows, dailyRows, outPath, imageMap, pendingOnly }) {
  // imageMap: { rowIndex: tmpImagePath }
  const imageMapJson = JSON.stringify(imageMap);
  const wrongJson    = JSON.stringify(wrongRows);
  const dailyJson    = JSON.stringify(dailyRows);
  const sheetName    = pendingOnly ? '待二刷错题' : '错题本';

  return `
import openpyxl
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.drawing.image import Image as XLImage
from openpyxl.utils import get_column_letter
import json, os

wrong_rows  = json.loads(${JSON.stringify(wrongJson)})
daily_rows  = json.loads(${JSON.stringify(dailyJson)})
image_map   = json.loads(${JSON.stringify(imageMapJson)})
out_path    = ${JSON.stringify(outPath)}
sheet_name  = ${JSON.stringify(sheetName)}

HEADER_BG  = "2D5FA1"
HEADER_FG  = "FFFFFF"
ROW_HEIGHT = 22
IMG_ROW_H  = 120   # 含图片行更高

wb = Workbook()

# ── Sheet 1: 错题本 ────────────────────────────────
ws = wb.active
ws.title = sheet_name

headers = ["日期","科目","题型","错误原因","题目内容","视觉描述","正确答案","解析/批注","知识点标签","状态","来源","截图"]
col_widths = [10, 12, 18, 12, 40, 45, 8, 30, 20, 10, 12, 20]

for ci, (h, w) in enumerate(zip(headers, col_widths), 1):
    cell = ws.cell(row=1, column=ci, value=h)
    cell.font      = Font(bold=True, color=HEADER_FG, name="Arial", size=10)
    cell.fill      = PatternFill("solid", start_color=HEADER_BG)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.column_dimensions[get_column_letter(ci)].width = w
ws.row_dimensions[1].height = 26
ws.freeze_panes = "A2"

for ri, row in enumerate(wrong_rows, 2):
    for ci, val in enumerate(row, 1):
        cell = ws.cell(row=ri, column=ci, value=val)
        cell.alignment = Alignment(vertical="top", wrap_text=(ci in [5, 6, 8]))
        cell.font = Font(name="Arial", size=9)

    # 嵌入截图（如果有）
    img_path = image_map.get(str(ri - 2))   # ri-2 对应 wrong_rows 的索引
    if img_path and os.path.exists(img_path):
        try:
            img = XLImage(img_path)
            # 按比例缩放到宽 160px
            ratio = 160 / img.width if img.width > 0 else 1
            img.width  = int(img.width  * ratio)
            img.height = int(img.height * ratio)
            col_letter = get_column_letter(len(headers))   # 最后一列
            ws.add_image(img, f"{col_letter}{ri}")
            ws.row_dimensions[ri].height = max(IMG_ROW_H, img.height * 0.75 + 10)
        except Exception as e:
            ws.cell(row=ri, column=len(headers), value=f"[图片加载失败: {e}]")
    else:
        has_visual = bool(row[5] if len(row) > 5 else None)
    ws.row_dimensions[ri].height = 60 if has_visual else ROW_HEIGHT

# ── Sheet 2: 每日记录 ─────────────────────────────
ws2 = wb.create_sheet("每日记录")
d_headers = ["日期","状态","心情","言语(错)","数量(错)","判断(错)","资料(错)","申论","总错题","备注"]
d_widths   = [12,    8,    8,    10,       10,       10,       10,       8,    8,    30]

for ci, (h, w) in enumerate(zip(d_headers, d_widths), 1):
    cell = ws2.cell(row=1, column=ci, value=h)
    cell.font      = Font(bold=True, color=HEADER_FG, name="Arial", size=10)
    cell.fill      = PatternFill("solid", start_color=HEADER_BG)
    cell.alignment = Alignment(horizontal="center", vertical="center")
    ws2.column_dimensions[get_column_letter(ci)].width = w
ws2.row_dimensions[1].height = 26
ws2.freeze_panes = "A2"

for ri, row in enumerate(daily_rows, 2):
    for ci, val in enumerate(row, 1):
        cell = ws2.cell(row=ri, column=ci, value=val)
        cell.alignment = Alignment(vertical="center")
        cell.font = Font(name="Arial", size=9)
    ws2.row_dimensions[ri].height = ROW_HEIGHT

wb.save(out_path)
print(out_path)
`.trim();
}

// ─── 主导出函数 ──────────────────────────────────────────────

async function exportXlsx({ pendingOnly = false, withImages = true } = {}) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const questions    = loadWrongQuestions();
  const dailyRecords = loadDailyRecords();
  const filtered     = pendingOnly ? questions.filter(q => q.status !== '已掌握') : questions;

  // ── 错题行数据 ───────────────────────────────────────────────
  const wrongRows = filtered.map(q => [
    q.date                          ?? '',
    q.module                        ?? '',
    q.subtype                       ?? '',
    q.error_reason                  ?? '',
    q.question_text                 ?? q.question_desc ?? '',
    q.visual_description            ?? '',          // 视觉描述（图形/图表题）
    q.answer                        ?? '',
    q.analysis ?? q.user_annotation ?? '',
    Array.isArray(q.keywords) ? q.keywords.join('、') : '',
    q.status                        ?? '待二刷',
    q.source_engine ?? (q.source === 'image' ? '图片' : '文字'),
    '',   // 截图列占位，由 Python 脚本填充图片
  ]);

  // ── 图片临时文件 ──────────────────────────────────────────────
  const tmpFiles = [];
  const imageMap = {};   // { rowIndex(string): tmpPath }

  if (withImages) {
    filtered.forEach((q, idx) => {
      if (!q.raw_image_b64) return;
      const tmpPath = path.join(os.tmpdir(), `qimg_${Date.now()}_${idx}.jpg`);
      try {
        fs.writeFileSync(tmpPath, Buffer.from(q.raw_image_b64, 'base64'));
        imageMap[String(idx)] = tmpPath;
        tmpFiles.push(tmpPath);
      } catch (_) {}
    });
  }

  // ── 每日记录行数据 ────────────────────────────────────────────
  const dailyRows = dailyRecords.map(r => {
    const m = r.modules ?? {};
    const totalWrong = ['言语理解','数量关系','判断推理','资料分析']
      .reduce((s, mod) => s + (m[mod]?.wrong ?? 0), 0);
    return [
      r.date                    ?? '',
      r.skipped ? '跳过' : '打卡',
      r.mood                    ?? '',
      m['言语理解']?.wrong       ?? '',
      m['数量关系']?.wrong       ?? '',
      m['判断推理']?.wrong       ?? '',
      m['资料分析']?.wrong       ?? '',
      m['申论']?.written ? '是' : '否',
      totalWrong || '',
      r.note                    ?? '',
    ];
  });

  // ── 生成并运行 Python 脚本 ─────────────────────────────────────
  const today    = new Date().toISOString().slice(0, 10);
  const suffix   = pendingOnly ? '_待二刷' : '';
  const outPath  = path.join(OUT_DIR, `备考记录_${today}${suffix}.xlsx`);

  const pyScript = buildPythonScript({ wrongRows, dailyRows, outPath, imageMap, pendingOnly });
  const tmpPy    = path.join(os.tmpdir(), `export_${Date.now()}.py`);
  fs.writeFileSync(tmpPy, pyScript, 'utf-8');

  try {
    await runPython([tmpPy]);
  } finally {
    try { fs.unlinkSync(tmpPy); } catch (_) {}
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }

  const pendingCount = questions.filter(q => q.status !== '已掌握').length;
  const imgCount     = Object.keys(imageMap).length;
  console.log(`[export] 已导出：${outPath}`);
  console.log(`[export] 错题 ${questions.length} 条，待二刷 ${pendingCount} 条，含截图 ${imgCount} 张`);
  console.log(`ATTACH:${outPath}`);

  return outPath;
}

// ─── CLI 入口 ─────────────────────────────────────────────────

if (require.main === module) {
  const pendingOnly = process.argv.includes('--pending-only');
  const withImages  = !process.argv.includes('--no-images');
  exportXlsx({ pendingOnly, withImages }).catch(e => {
    console.error('[export] 失败:', e);
    process.exit(1);
  });
}

module.exports = { exportXlsx };
