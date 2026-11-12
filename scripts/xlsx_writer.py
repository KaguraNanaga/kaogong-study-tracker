#!/usr/bin/env python3
"""
xlsx_writer.py —— 由 export_xlsx.js 调用，不需要手动运行。
用法：python xlsx_writer.py <payload.json>

payload: {
  "out_path": "...", "sheet_name": "...",
  "wrong_rows": [[...], ...], "daily_rows": [[...], ...],
  "images": {"行号(0起)": "图片路径"}
}
依赖：openpyxl（必需）、Pillow（嵌入截图需要）
"""
import json
import sys

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
except ImportError:
    print("KAOGONG_ERR:missing_openpyxl", file=sys.stderr)
    sys.exit(3)

try:
    from openpyxl.drawing.image import Image as XLImage
    import PIL  # noqa: F401  openpyxl 嵌图依赖 Pillow，缺了会在每张图上报错
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

HEADER_BG, HEADER_FG = "2D5FA1", "FFFFFF"
ROW_H = 22
MAX_ROW_PT = 409          # Excel 行高上限 409 磅，超出会被判定为损坏或被截断
IMG_MAX_W, IMG_MAX_H = 220, 520   # 像素；长截图按高度限制等比缩小


def clean(v):
    """去掉 Excel 不允许的控制字符（模型/OCR 输出里偶尔会有，openpyxl 遇到会直接报错中断整个导出）。"""
    if not isinstance(v, str):
        return v
    return ILLEGAL_CHARACTERS_RE.sub("", v)


def put(ws, row, col, value):
    """写单元格；以 = 开头的文本强制按文本存，避免被当成公式。"""
    c = ws.cell(row=row, column=col, value=clean(value))
    if isinstance(c.value, str) and c.value.startswith("="):
        c.data_type = "s"
    return c


def to_excel_format(path):
    """Excel 只认 PNG/JPEG/GIF。WebP/BMP 等先转成 PNG，
    否则 openpyxl 在保存时才报 KeyError: '.webp'，整个导出失败。"""
    from PIL import Image
    with Image.open(path) as im:
        if im.format in ("PNG", "JPEG", "GIF"):
            return path
        out = path.rsplit(".", 1)[0] + ".converted.png"
        im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB").save(out, "PNG")
        return out


def style_header(ws, headers, widths):
    for ci, (h, w) in enumerate(zip(headers, widths), 1):
        c = ws.cell(row=1, column=ci, value=h)
        c.font = Font(bold=True, color=HEADER_FG, size=10)
        c.fill = PatternFill("solid", start_color=HEADER_BG)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(ci)].width = w
    ws.row_dimensions[1].height = 26
    ws.freeze_panes = "A2"


def main(payload_path):
    with open(payload_path, encoding="utf-8") as f:
        p = json.load(f)

    wb = Workbook()
    ws = wb.active
    ws.title = p["sheet_name"]
    headers = ["日期", "科目", "题型", "错误原因", "题目内容", "视觉描述", "正确答案",
               "解析/批注", "知识点标签", "状态", "来源", "截图"]
    widths = [11, 10, 16, 11, 45, 40, 8, 28, 18, 9, 8, 32]
    style_header(ws, headers, widths)
    img_col = get_column_letter(len(headers))
    wrap_cols = {5, 6, 8}
    img_ok = img_fail = 0
    bad = set(p.get("bad_images", []))

    for ri, row in enumerate(p["wrong_rows"], 2):
        for ci, val in enumerate(row, 1):
            c = put(ws, ri, ci, val)
            c.alignment = Alignment(vertical="top", wrap_text=ci in wrap_cols)
            c.font = Font(size=9)

        height = 60 if (row[4] and len(str(row[4])) > 40) or row[5] else ROW_H
        img_path = p["images"].get(str(ri - 2))
        if (ri - 2) in bad:
            put(ws, ri, len(headers), "[截图数据损坏，无法显示]")
        if img_path:
            if not HAS_PIL:
                put(ws, ri, len(headers), "[未安装 Pillow，截图未嵌入：pip install pillow]")
            else:
                try:
                    img = XLImage(to_excel_format(img_path))
                    scale = min(IMG_MAX_W / img.width, IMG_MAX_H / img.height, 1.0)
                    img.width, img.height = int(img.width * scale), int(img.height * scale)
                    ws.add_image(img, f"{img_col}{ri}")
                    height = max(height, img.height * 0.75 + 8)
                    img_ok += 1
                except Exception as e:  # 单张图坏了不影响整个导出
                    put(ws, ri, len(headers), f"[截图无法读取: {e}]")
                    img_fail += 1
        ws.row_dimensions[ri].height = min(height, MAX_ROW_PT)

    ws2 = wb.create_sheet("每日记录")
    d_headers = ["日期", "状态", "心情", "常识(错)", "言语(错)", "数量(错)", "判断(错)", "资料(错)",
                 "申论", "总错题", "备注"]
    d_widths = [12, 8, 8, 9, 9, 9, 9, 9, 8, 8, 40]
    style_header(ws2, d_headers, d_widths)
    for ri, row in enumerate(p["daily_rows"], 2):
        for ci, val in enumerate(row, 1):
            c = put(ws2, ri, ci, val)
            c.alignment = Alignment(vertical="center")
            c.font = Font(size=9)

    try:
        wb.save(p["out_path"])
    except PermissionError:
        print("KAOGONG_ERR:file_locked", file=sys.stderr)
        sys.exit(4)

    print(json.dumps({"out_path": p["out_path"], "img_ok": img_ok, "img_fail": img_fail,
                      "has_pil": HAS_PIL}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1])
