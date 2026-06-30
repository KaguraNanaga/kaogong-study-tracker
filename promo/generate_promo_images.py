from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "promo"
W, H = 1440, 1920

FONT_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_REG = "/System/Library/Fonts/STHeiti Light.ttc"


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


F = {
    "title": font(86, True),
    "subtitle": font(40),
    "h1": font(58, True),
    "h2": font(42, True),
    "body": font(34),
    "body_bold": font(34, True),
    "small": font(26),
    "tiny": font(22),
    "table": font(25),
    "table_bold": font(25, True),
}


COL = {
    "bg": "#F7F3EA",
    "paper": "#FFFDF7",
    "ink": "#24201C",
    "muted": "#746D63",
    "line": "#E4D8C6",
    "red": "#B93A32",
    "blue": "#2D5FA1",
    "green": "#2F7D57",
    "gold": "#B9822B",
    "soft_red": "#F8E8E4",
    "soft_blue": "#E7EEF9",
    "soft_green": "#E6F2EB",
    "soft_gold": "#F6EBD5",
}


def text_w(draw, text, fnt):
    if not text:
        return 0
    box = draw.textbbox((0, 0), text, font=fnt)
    return box[2] - box[0]


def text_h(draw, text, fnt):
    box = draw.textbbox((0, 0), text or "国", font=fnt)
    return box[3] - box[1]


def wrap(draw, text, fnt, max_w):
    lines = []
    for para in text.split("\n"):
        cur = ""
        for ch in para:
            if text_w(draw, cur + ch, fnt) <= max_w:
                cur += ch
            else:
                if cur:
                    lines.append(cur)
                cur = ch
        lines.append(cur)
    return lines


def wrapped_height(draw, text, fnt, max_w, line_gap=10):
    lines = wrap(draw, text, fnt, max_w)
    if not lines:
        return 0
    return sum(text_h(draw, line, fnt) for line in lines) + line_gap * (len(lines) - 1)


def fit_font(draw, text, max_w, max_h, start_size, bold=False, min_size=18, line_gap=10):
    size = start_size
    while size > min_size:
        fnt = font(size, bold)
        if wrapped_height(draw, text, fnt, max_w, line_gap) <= max_h:
            return fnt
        size -= 2
    return font(min_size, bold)


def draw_text(draw, xy, text, fnt, fill=COL["ink"], max_w=None, line_gap=10):
    x, y = xy
    if max_w:
        lines = wrap(draw, text, fnt, max_w)
    else:
        lines = text.split("\n")
    for line in lines:
        draw.text((x, y), line, font=fnt, fill=fill)
        y += text_h(draw, line, fnt) + line_gap
    return y


def rr(draw, box, fill, outline=None, width=1, r=8):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def pill(draw, x, y, text, fill, fg=None, pad_x=20, pad_y=10):
    fg = fg or COL["ink"]
    fnt = F["small"]
    tw = text_w(draw, text, fnt)
    th = text_h(draw, text, fnt)
    box = (x, y, x + tw + pad_x * 2, y + th + pad_y * 2)
    rr(draw, box, fill, r=8)
    draw.text((x + pad_x, y + pad_y - 2), text, font=fnt, fill=fg)
    return box[2]


def base():
    im = Image.new("RGB", (W, H), COL["bg"])
    draw = ImageDraw.Draw(im)
    draw.rectangle((0, 0, W, 180), fill="#EEE2D1")
    draw.rectangle((0, H - 170, W, H), fill="#ECE7DC")
    return im, draw


def footer(draw):
    draw.text((96, H - 112), "朱批录 · kaogong-study-tracker", font=F["small"], fill=COL["muted"])
    draw.text((96, H - 74), "GitHub: KaguraNanaga/kaogong-study-tracker", font=F["tiny"], fill=COL["muted"])


def logo(draw, x=96, y=62):
    mark = OUT.parent / "assets" / "crane_zhupi.png"
    if mark.exists():
        img = Image.open(mark).convert("RGB")
        img.thumbnail((120, 72))
        draw.rounded_rectangle((x - 8, y - 8, x + 128, y + 80), radius=8, fill=COL["paper"])
        canvas.paste(img, (x, y))
    draw.text((x + 150, y + 10), "朱批录", font=F["h2"], fill=COL["red"])
    draw.text((x + 150, y + 58), "通用 Agent 错题整理 Skill", font=F["small"], fill=COL["muted"])


def draw_question_card(draw, box):
    x1, y1, x2, y2 = box
    rr(draw, box, COL["paper"], outline=COL["line"], width=2, r=8)
    draw.rectangle((x1, y1, x2, y1 + 74), fill=COL["soft_red"])
    draw.text((x1 + 28, y1 + 22), "题目截图", font=F["small"], fill=COL["red"])
    y = y1 + 108
    question = "已知：甲参加则乙参加；只有丙参加，丁才参加。问哪项一定为真？"
    y = draw_text(draw, (x1 + 34, y), question, F["tiny"], max_w=x2 - x1 - 68, line_gap=6)
    opts = ["A. 甲参加则丁参加", "B. 丁参加则丙参加", "C. 乙参加则甲参加", "D. 丙参加则甲参加"]
    for opt in opts:
        color = COL["green"] if opt.startswith("B") else COL["ink"]
        draw.text((x1 + 34, y + 10), opt, font=F["tiny"], fill=color)
        y += 38
    if y + 76 <= y2:
        rr(draw, (x1 + 34, y + 22, x1 + 200, y + 68), COL["soft_gold"], r=8)
        draw.text((x1 + 54, y + 32), "我选了 A", font=F["tiny"], fill=COL["gold"])


def draw_phone(draw, box, title):
    x1, y1, x2, y2 = box
    rr(draw, box, "#151515", r=44)
    rr(draw, (x1 + 22, y1 + 22, x2 - 22, y2 - 22), "#F8F6F2", r=34)
    draw.text((x1 + 58, y1 + 58), title, font=F["small"], fill=COL["ink"])
    draw.line((x1 + 40, y1 + 112, x2 - 40, y1 + 112), fill=COL["line"], width=2)


def bubble(draw, box, text, mine=False, fnt=None):
    fill = COL["soft_blue"] if mine else COL["paper"]
    outline = "#C8D8F0" if mine else COL["line"]
    rr(draw, box, fill, outline=outline, width=1, r=8)
    start_size = getattr(fnt or F["small"], "size", 26)
    fnt = fit_font(draw, text, box[2] - box[0] - 48, box[3] - box[1] - 40, start_size, line_gap=8)
    draw_text(draw, (box[0] + 24, box[1] + 20), text, fnt, max_w=box[2] - box[0] - 48, line_gap=8)


def cover():
    global canvas
    canvas, draw = base()
    footer(draw)
    logo(draw)
    draw.text((96, 270), "把错题截图丢给它", font=F["title"], fill=COL["ink"])
    draw.text((96, 374), "自动长出一本错题本", font=F["title"], fill=COL["red"])
    draw_text(draw, (100, 505), "适合国考/省考刷题后整理：截图识别、原因归类、Excel 导出、二刷提醒。Trae / Cursor / opencode / Hermes 等 agent 都能接。", F["body"], fill=COL["muted"], max_w=930, line_gap=14)

    pill(draw, 100, 690, "截图进来", COL["soft_red"], COL["red"])
    pill(draw, 310, 690, "错题归档", COL["soft_blue"], COL["blue"])
    pill(draw, 520, 690, "表格导出", COL["soft_green"], COL["green"])
    pill(draw, 730, 690, "定时二刷", COL["soft_gold"], COL["gold"])

    draw_phone(draw, (650, 835, 1280, 1580), "备考助手")
    draw_question_card(draw, (710, 960, 1220, 1325))
    bubble(draw, (760, 1380, 1200, 1510), "已整理：判断推理 · 逻辑判断\n原因：粗心\n标签：假言命题、必要条件\n状态：待二刷", mine=False)

    rr(draw, (96, 910, 570, 1260), COL["paper"], outline=COL["line"], width=2)
    draw.text((136, 952), "为什么好用", font=F["h2"], fill=COL["ink"])
    points = ["不用再手抄题干", "图形/表格题能存原截图", "复习时按待二刷抽题", "Excel 可继续喂给大模型分析"]
    y = 1030
    for p in points:
        draw.ellipse((140, y + 12, 156, y + 28), fill=COL["red"])
        draw.text((180, y), p, font=F["body"], fill=COL["ink"])
        y += 58
    canvas.save(OUT / "01-cover.png")


def flow():
    global canvas
    canvas, draw = base()
    footer(draw)
    logo(draw)
    draw.text((96, 245), "最常见的使用场景", font=F["h1"], fill=COL["ink"])
    draw_text(draw, (100, 320), "做完题后直接发截图，不用打开表格，也不用手动分类。", F["body"], fill=COL["muted"], max_w=1050)

    draw_phone(draw, (96, 470, 1344, 1550), "任意支持脚本和图片模型的 Agent")
    bubble(draw, (150, 610, 650, 715), "这题我选错了，主要是粗心", mine=True)
    draw_question_card(draw, (160, 745, 720, 1138))
    bubble(draw, (570, 1185, 1270, 1432), "收到了，已归档为：\n判断推理 · 逻辑判断\n错误原因：粗心\n正确答案：B\n知识点：假言命题、必要条件\n状态：待二刷", mine=False, fnt=F["body"])

    y = 1590
    for i, t in enumerate(["发截图", "自动提取题目", "归类原因", "写进错题本"]):
        x = 130 + i * 310
        rr(draw, (x, y, x + 235, y + 82), [COL["soft_red"], COL["soft_blue"], COL["soft_green"], COL["soft_gold"]][i], r=8)
        draw.text((x + 36, y + 24), t, font=F["small"], fill=[COL["red"], COL["blue"], COL["green"], COL["gold"]][i])
        if i < 3:
            draw.text((x + 254, y + 20), ">", font=F["h2"], fill=COL["muted"])
    canvas.save(OUT / "02-chat-flow.png")


def workbook():
    global canvas
    canvas, draw = base()
    footer(draw)
    logo(draw)
    draw.text((96, 245), "整理结果长这样", font=F["h1"], fill=COL["ink"])
    draw_text(draw, (100, 320), "错题本和每日记录会导出成一个 Excel，截图也能嵌在对应行。", F["body"], fill=COL["muted"], max_w=1120)

    rr(draw, (96, 470, 1344, 1320), COL["paper"], outline=COL["line"], width=2)
    draw.rectangle((96, 470, 1344, 542), fill=COL["blue"])
    draw.text((132, 490), "备考记录_2026-06-30.xlsx", font=F["small"], fill="white")
    tabs = [("错题本", 130, COL["soft_blue"], COL["blue"]), ("每日记录", 290, "#F2F2F2", COL["muted"])]
    for text, x, fill, fg in tabs:
        rr(draw, (x, 570, x + 140, 620), fill, r=8)
        draw.text((x + 28, 582), text, font=F["tiny"], fill=fg)

    headers = ["日期", "科目", "题型", "原因", "题目内容", "答案", "标签", "状态"]
    widths = [125, 135, 170, 120, 390, 80, 170, 115]
    x = 128
    y = 665
    for h, wid in zip(headers, widths):
        draw.rectangle((x, y, x + wid, y + 58), fill="#EEF3F9", outline=COL["line"])
        draw.text((x + 14, y + 17), h, font=F["table_bold"], fill=COL["blue"])
        x += wid
    rows = [
        ["06-30", "判断推理", "逻辑判断", "粗心", "如果甲参加，则乙参加；只有丙参加，丁才参加……", "B", "假言命题", "待二刷"],
        ["06-30", "资料分析", "增长率", "公式不熟", "2019-2023 年产量同比变化图……", "C", "增长率", "待二刷"],
        ["06-29", "言语理解", "主旨概括", "概念混淆", "这段文字意在说明……", "D", "主旨题", "已掌握"],
    ]
    y += 58
    for idx, row in enumerate(rows):
        x = 128
        row_h = 92
        for val, wid in zip(row, widths):
            fill = "#FFFFFF" if idx % 2 == 0 else "#FBF8F0"
            draw.rectangle((x, y, x + wid, y + row_h), fill=fill, outline=COL["line"])
            fnt = F["table"]
            color = COL["green"] if val == "已掌握" else (COL["red"] if val == "待二刷" else COL["ink"])
            draw_text(draw, (x + 10, y + 15), val, fnt, fill=color, max_w=wid - 20, line_gap=4)
            x += wid
        y += row_h

    rr(draw, (150, 1080, 440, 1235), COL["soft_red"], r=8)
    draw.text((188, 1118), "Sheet 1", font=F["small"], fill=COL["red"])
    draw.text((188, 1160), "错题本", font=F["h2"], fill=COL["red"])
    rr(draw, (510, 1080, 800, 1235), COL["soft_green"], r=8)
    draw.text((548, 1118), "Sheet 2", font=F["small"], fill=COL["green"])
    draw.text((548, 1160), "每日记录", font=F["h2"], fill=COL["green"])
    rr(draw, (870, 1080, 1190, 1235), COL["soft_gold"], r=8)
    draw.text((908, 1118), "可选", font=F["small"], fill=COL["gold"])
    draw.text((908, 1160), "嵌入截图", font=F["h2"], fill=COL["gold"])

    rr(draw, (96, 1395, 1344, 1595), COL["paper"], outline=COL["line"], width=2)
    draw.text((136, 1430), "适合继续分析", font=F["h2"], fill=COL["ink"])
    draw_text(draw, (136, 1492), "把导出的 Excel 发给 Kimi / ChatGPT，让它帮你看最近哪类题最容易错。", F["body"], fill=COL["muted"], max_w=1120)
    canvas.save(OUT / "03-workbook.png")


def review():
    global canvas
    canvas, draw = base()
    footer(draw)
    logo(draw)
    draw.text((96, 245), "不只是记录，还会拉你回来复习", font=F["h1"], fill=COL["ink"])
    draw_text(draw, (100, 320), "晚间总结看当天弱项，二刷提醒从待复习错题里抽题。", F["body"], fill=COL["muted"], max_w=1120)

    rr(draw, (120, 510, 1320, 840), COL["paper"], outline=COL["line"], width=2)
    pill(draw, 160, 550, "21:00 今日总结", COL["soft_blue"], COL["blue"])
    summary = "今日总结：判断推理 8 错 / 数量关系 5 错 / 言语理解 4 错 / 资料分析 3 错\n判断推理错得多，明天专项刷逻辑判断，重点看假言命题。\n今天打卡完成。"
    draw_text(draw, (160, 625), summary, F["body"], max_w=1080, line_gap=12)

    rr(draw, (120, 920, 1320, 1330), COL["paper"], outline=COL["line"], width=2)
    pill(draw, 160, 960, "隔天 20:00 二刷提醒", COL["soft_red"], COL["red"])
    reminder = "抽到 1 道待复习的题：\n[判断推理 · 逻辑判断]\n如果甲参加，则乙参加；只有丙参加，丁才参加。问哪项一定为真？\n正确答案：B\n知识点：假言命题、必要条件\n还记得这题的解法吗？回复：记得 / 不记得"
    draw_text(draw, (160, 1035), reminder, F["body"], max_w=1080, line_gap=10)

    rr(draw, (120, 1410, 1320, 1608), COL["soft_green"], outline="#BBD8C8", width=2)
    draw.text((160, 1452), "本地优先", font=F["h2"], fill=COL["green"])
    draw_text(draw, (160, 1514), "错题数据和截图默认存在自己的电脑里；只有主动同步飞书时，才上传到你的飞书文档。", F["body"], fill=COL["ink"], max_w=1080)
    canvas.save(OUT / "04-review-reminder.png")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    cover()
    flow()
    workbook()
    review()
    for p in sorted(OUT.glob("0*.png")):
        print(p)
