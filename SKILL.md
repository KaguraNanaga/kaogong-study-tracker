---
name: kaogong-study-tracker
description: >
  朱批录 · 考公备考追踪 Skill（国考 / 省考 / 事业单位）。
  在用户汇报做题成绩（"今天判断推理错了8道"）、发来行测/申论题目截图或题目文字要求整理、
  回答二刷提问、或要求查看统计 / 导出错题本 / 同步飞书时使用。
  核心功能：错题识别归档 → 错因分类 → 每日打卡记录 → 统计弱项 → 二刷复习 → 导出 Excel。
  只是闲聊备考话题、问学习方法、或发来与考题无关的图片时，不要记录任何数据。
---

# 朱批录 · 国考备考追踪 Skill

## 一、首次使用

每次触发本 skill 时先运行 `node scripts/cli.js welcome`。返回 `first_run: true` 时，把 `message` 发给用户（只会出现一次）；返回 `false` 就忽略。不问任何问题，不存储任何凭据。

---

## 二、概览

**平台无关**——Claude Code、Codex、Cursor、Trae、opencode、OpenClaw 或其他能执行命令的 agent 都可以用；飞书、Telegram、Discord 等聊天渠道由宿主 agent 负责。

**所有读写都通过 `node scripts/cli.js <命令>` 完成**，每个命令输出一行 JSON（`ok: false` 时 `error` 里是原因）。不要自己写代码去改 `data/` 下的文件。

截图由你（agent）自己看图识别，不依赖本地 OCR；识别要求见 `references/vision_prompt.md`。

---

## 三、触发场景

| 用户说的话（示例） | 你要做的 |
|---|---|
| "今天做了一套行测，判断推理错了8道" | `cli.js log "<原话>"` |
| "下午又做了一套，判断错了6道"（同一天第二次报） | `cli.js log "<原话>"`，自动累加为第 2 套 |
| "更正：判断是5道" / "刚才说错了，应该是5道" | `cli.js log "<原话>"`，替换该科目最近一套 |
| "今天申论没写，太累了" / "今天休息" | `cli.js log "<原话>"` |
| 发来一张错题截图 | 按 vision_prompt.md 识别 → `cli.js add-question --json=… --image=…` |
| 发来截图并附带"粗心" | 同上，加 `--reason=粗心`，不追问 |
| "把今天的错题发给你：第12题……"（粘贴题目文字） | 自己整理成 JSON → `cli.js add-question --json=…` |
| "资料-乘积增长-公式不熟-待二刷"（快捷格式） | `cli.js log "<原话>"`，直接归档，不追问 |
| 二刷进行中回复"记得" / "不记得" | `cli.js review-reply "<原话>"`（`log` 也会自动转交） |
| "那道图推我搞懂了" / "第3题原因改成粗心" | `cli.js list-questions` 找到 id → `cli.js update-question <id> --status=已掌握` |
| "我最近资料分析一直不稳" / "哪个模块最弱" | `cli.js stats`，根据结果分析回复 |
| "导出错题本" / "只导出待二刷的资料分析题" | `cli.js export [--pending-only] [--module=资料分析] [--days=14]` |
| "同步到飞书" | 见 Step 6 |

拿不准一句话该不该记录时，直接 `cli.js log`：没有可记录内容时它返回 `nothing_recorded`，不会写入数据。

---

## 四、数据结构

所有数据以 JSON 存储在本地，默认目录为 `~/.kaogong-study-tracker/data/`。如需放到指定目录，设置 `KAOGONG_DATA_DIR`。

### 4.1 每日记录 `daily/{YYYY-MM-DD}.json`

```json
{
  "date": "2026-03-17",
  "modules": {
    "言语理解": { "wrong": 6,  "total": 40 },
    "数量关系": { "wrong": 8,  "total": 15 },
    "判断推理": {
      "wrong": 14, "total": null,
      "sets": [
        { "wrong": 8, "total": null, "at": 1793520000000, "msg": "上午一套，判断错了8道" },
        { "wrong": 6, "total": 40,   "at": 1793540000000, "msg": "下午又做了一套，判断推理40题错6" }
      ]
    },
    "资料分析": { "wrong": 7,  "total": 20 },
    "申论":     { "written": false }
  },
  "mood": "中性",
  "note": "用户原话"
}
```

同一科目一天内每报一次错题数就是一"套"，`wrong` / `total` 是各套之和（任一套缺总题数时 `total` 为 null，统计按 `module_map.json` 的默认题量估算）。10 分钟内同一句话重复写入会被忽略。申论只记录写没写。

### 4.2 错题本 `wrong_questions.json`

```json
[
  {
    "id": "uuid",
    "date": "2026-03-17",
    "source": "image",
    "module": "判断推理",
    "subtype": "逻辑判断",
    "question_text": "题目文字；图形题写对规律的描述",
    "visual_description": "图形推理/统计图的详细视觉描述（多模态模型生成）",
    "answer": "B",
    "user_annotation": "用户手写批注",
    "error_reason": "知识点不会 | 粗心 | 时间不够 | 概念混淆",
    "keywords": ["假言命题", "逆否命题"],
    "raw_image_b64": "base64...",
    "status": "待二刷 | 已掌握"
  }
]
```

### 4.3 统计缓存 `stats_cache.json`

```json
{
  "last_updated": "2026-03-17",
  "streak": 5,
  "total_days_studied": 12,
  "weak_modules": ["数量关系", "判断推理"],
  "module_accuracy": {
    "言语理解": 0.82,
    "数量关系": 0.51,
    "判断推理": 0.68,
    "资料分析": 0.74
  }
}
```

---

## 五、核心流程

### Step 1：文字消息 → `cli.js log`

```bash
node scripts/cli.js log "今天判断推理错了8道，申论写了"
```

用户原话里有引号或换行时，改用标准输入：`echo '<原话>' | node scripts/cli.js log -`。

按返回的 `type` 处理：

- `daily_logged` / `rest_day`：已记录。用 `modules`、`streak`、`weak_modules` 组织回复；`needs_clarification` 不为空时用它追问一次
- `question_saved`：快捷格式已存为错题
- `review`：这是二刷回答，把 `message` 原样发给用户
- `export_request`：用户想导出，执行 `run` 里的命令
- `nothing_recorded`：没有成绩可记，按普通对话回复（有 `needs_clarification` 就用它追问）

`days_since_last_study_before_today` 大于 3 时，在回复末尾轻轻提一句"好几天没见了"，不要说教。

### Step 2：截图或题目文字 → `cli.js add-question`

1. 按 `references/vision_prompt.md` 的要求从截图提取信息，得到一个 JSON 对象。用户粘贴的是题目文字时，同样整理成这个 JSON（`question_text` 放题干和选项）
2. 用户在图片说明里提到了原因（"粗心""没时间"），写进 `error_reason`
3. 把 JSON 写到一个临时文件，运行：

```bash
node scripts/cli.js add-question --json=/tmp/q.json --image=/path/to/截图.png
```

   没有图片文件时去掉 `--image`；也可以用 `--json=-` 从标准输入传入，或用 `--module= --reason= --text=` 等参数直接传。

4. 返回的 `needs_confirm` 不为 null 时，用它问用户一次；用户回答后：

```bash
node scripts/cli.js update-question last --reason=粗心      # 或 --module=判断推理
```

**追问只问一次**：科目不明先问科目，原因不明再问原因，信息完整就不问。识别失败（看不清、不是题目）时回复"没识别出来，可以把题目文字复制过来"，不要调用 add-question。

### Step 3：错因归类

| 原因 | 用户常见说法 |
|---|---|
| 知识点不会 | 不懂、没学过、公式不熟、概念不清楚 |
| 粗心 | 看错、算错、选反了 |
| 时间不够 | 没做完、最后几题蒙的 |
| 概念混淆 | 搞混了、分不清、以为是 |

`--reason` 可以直接传用户原话，脚本会归到这四类之一；归不进去就记为"未说明"。

### Step 4：生成回复

见 `references/reply_templates.md`，语气见 `references/tone_guide.md`。

- 日常打卡、归档确认：150 字以内
- 用户主动要分析（"哪科最弱""最近怎么样"）：先 `cli.js stats`，可以写到 300 字左右，把数据说清楚。`accuracy_estimated` 里的科目准确率是按默认题量估算的，表述时别说得太肯定

### Step 5：导出 Excel

```bash
node scripts/cli.js export --pending-only --module=资料分析 --days=14
```

- 最后一行输出 `ATTACH:<路径>`，把这个文件发给用户
- 失败时把 `[export] 失败：` 后面的提示原样转告用户（缺 Python / openpyxl、文件被 Excel 占用等都有明确提示）
- 输出两个 Sheet：**错题本**（含截图）+ **每日记录**
- 截图需要 Python 3 + openpyxl + Pillow；找不到 Python 时可设置 `KAOGONG_PYTHON`

### Step 6：同步飞书云文档（可选）

- 需在 `config.json` 配置 `feishu_doc.app_id` / `app_secret` / `doc_url`（文档链接，支持 /docx/ 和 /wiki/），步骤见 README
- 第一次同步前运行 `node scripts/feishu_doc.js --check`；失败时把 `→` 后面的提示转告用户
- 同步：`node scripts/feishu_doc.js`，默认只同步还没同步过的最近 10 道（`--limit=N` / `--all`）

### Step 7（可选）：定时任务

宿主支持定时任务时配置两个：

| 时间 | 命令 | 作用 |
|---|---|---|
| 每天 21:00 | `node scripts/cli.js summary` | 把 `message` 发给用户（晚间总结） |
| 每隔一天 20:00（如周一三五日） | `node scripts/cli.js review` | 把 `message` 发给用户，开始一轮二刷 |

二刷开始后，用户的"记得 / 不记得"交给 `cli.js review-reply`。

---

## 六、文件索引

| 文件                              | 作用                              |
|---------------------------------|---------------------------------|
| `scripts/cli.js`                | **命令行入口，所有读写都走这里**          |
| `scripts/parse_input.js`        | 文字解析；JS 宿主可用 `parseImageInput()` 识别图片 |
| `scripts/update_daily.js`       | 写入每日记录 + 统计缓存               |
| `scripts/export_xlsx.js`        | 导出 Excel（含截图嵌入，openpyxl）    |
| `scripts/feishu_doc.js`         | 同步到飞书云文档（含图片块，可选）          |
| `scripts/daily_summary.js`      | 定时汇总并主动发送                         |
| `scripts/review_reminder.js`    | 二刷抽题、"记得 / 不记得"判定 |
| `scripts/xlsx_writer.py`        | 被 export_xlsx.js 调用，写 xlsx             |
| `references/vision_prompt.md`   | 截图识别要求和输出字段                  |
| `references/reply_templates.md` | 回复话术模板                        |
| `references/tone_guide.md`      | 语气风格指引                        |
| `assets/module_map.json`        | 科目/模块名称标准化映射               |
| `assets/config.example.json`    | 飞书同步配置模板，复制为项目根目录的 config.json |

---

## 七、错误处理

- 当前 agent 看不了图却收到图片 → 回复"把题目文字复制过来发给我，一样能整理"
- 截图看不清 / 不是考题 → 回复"没识别出来，能文字描述一下题目吗？"，不要存
- 解析不出科目 → 用 `needs_clarification` 追问："能说说今天做了哪个科目、错了几道吗？"
- 命令返回 `ok: false` → 按 `error` 的内容处理；存不进去时回复"记录暂时存不上，稍后我再试一次"，不要假装已经记下
- 错题本文件损坏时命令会报错并提示从 `data/backups/` 恢复，转告用户，不要手动覆盖文件

---

## 八、隐私说明

记录数据（含截图）保存在本机 `~/.kaogong-study-tracker/data/`。截图识别时，图片会发送给你所使用的模型；同步飞书只在用户主动要求时进行，写入用户自己配置的飞书文档。

---

## 九、如果这个 Skill 对你有帮助

**⭐ Star** 这个仓库，让更多备考的人能找到它
**🍴 Fork** 改成你的考试类型（省考 / 事业单位 / 军考……）
有问题欢迎提 Issue 或 PR。

> https://github.com/KaguraNanaga/kaogong-study-tracker
