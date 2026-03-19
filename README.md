# 朱批录 · kaogong-study-tracker

> 一个运行在你电脑上的考公备考助手，基于 [OpenClaw](https://openclaw.ai) Skill 框架构建。
> 把每天的套题截图或成绩发给它，它帮你归档错题、分析弱点、定时提醒——所有数据留在本地，不上传任何云端。

[![OpenClaw Skill](https://img.shields.io/badge/OpenClaw-Skill-orange)](https://openclaw.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node ≥18](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

---

## 为什么做这个

备考行测、申论，每天刷套题是标准动作。但大多数人的复习路径是这样的：

> 做完一套卷子 → 对答案 → 叹口气 → 翻篇 → 明天继续

真正提分的部分——错题归类、原因分析、二刷追踪——因为太麻烦，往往被跳过。

朱批录想解决的就是这件事：**让"做完题之后的整理"变得几乎不需要努力**。你只需要把错题截图发出来，或者发一句"今天判断推理错了8道"，剩下的它来做。

---

## 它能做什么

### 错题自动识别与归档

发一张错题截图，朱批录调用你配置的多模态模型（qwen3-vl、kimi-k2.5、claude-sonnet-4-6 等），自动提取：

- 题目完整内容（包括图形推理的视觉描述、统计图的数据）
- 所属科目和题型
- 正确答案（如图片中可见）
- 错误原因推测（知识点不会 / 粗心 / 时间不够 / 概念混淆）
- 知识点标签

识别失败时，提示你把文字复制粘贴发过来，一样可以整理。

### 每日打卡与进度追踪

直接用自然语言汇报：

```
今天行测做完了，言语4错，判断8错，数量5错，资料3错
```

朱批录记录进度，统计各模块7日准确率，找出弱项。

### 晚间自动总结

每天21:00主动发一条消息，汇总当天成绩、指出最弱模块、给一条具体的明天建议。不需要你主动问。

### 导出 Excel 错题本

说"导出错题本"，生成一份包含两个 Sheet 的 `.xlsx` 文件：

- **错题本**：题目内容、图形视觉描述、错误原因、知识点标签、二刷状态，截图原图嵌入对应行
- **每日记录**：各科目错题数流水账

这份文件可以直接发给 Kimi、ChatGPT 或其他模型，让它帮你分析近期趋势、给出复习建议。

### 同步到飞书云文档（可选）

说"同步到飞书"，把最新错题（含截图原图）写入飞书云文档，手机上直接查看，对图形推理题尤其有用。

---

## 设计原则

**对话即操作**——一切通过聊天完成，不需要打开任何 App、不需要编辑配置文件。

**本地优先**——错题数据（包括截图）存在你自己电脑的 `~/.openclaw/` 里，不经过任何第三方服务器。

**失败软降级**——图片识别失败时给出明确提示，引导手动输入，不中断流程。

**不啰嗦**——每条回复控制在150字以内，只说最关键的一件事。

---

## 支持的考试类型

朱批录的科目映射默认覆盖国考/省考标准科目，也适用于：

| 考试类型 | 适配情况 |
|---------|---------|
| 国家公务员考试（国考） | 完整支持，行测5模块 + 申论 |
| 省级公务员考试（省考） | 支持，部分省份题型有差异可 Fork 调整 |
| 事业单位联考（职测） | 支持，科目名称略有不同 |
| 军队文职考试 | 基本支持，部分模块名需手动映射 |
| 选调生考试 | 支持 |

---

## 支持的聊天渠道

OpenClaw 支持哪个渠道，朱批录就支持哪个，逻辑层完全平台无关。

| 渠道 | 说明 |
|------|-----|
| 飞书 | 推荐，国内访问稳定，支持图片消息 |
| Telegram | 需要科学上网，体验流畅 |
| WhatsApp | 支持 |
| Discord | 支持 |
| iMessage | 支持（macOS 设备） |

---

## 快速安装

### 前置条件

- [OpenClaw](https://openclaw.ai) 已安装并运行（Node.js ≥ 18）

### 安装步骤


```bash
# 1. 克隆到 OpenClaw 的 skills 目录
cd ~/.openclaw/skills
git clone https://github.com/KaguraNanaga/kaogong-study-tracker

# 2. 安装依赖
cd kaogong-study-tracker
npm install

# 3. 在 workspace.yaml 中启用
```

在你的 `workspace.yaml` 中添加：

```yaml
skills:
  - kaogong-study-tracker

cron_jobs:
  - name: "备考晚间总结"
    schedule: "0 21 * * *"
    action:
      type: run_script
      script: skills/kaogong-study-tracker/scripts/daily_summary.js
      channel: feishu   # 改成你用的渠道
```

详细的飞书接入配置参考 [`assets/workspace-example.yaml`](assets/workspace-example.yaml)。

### 首次使用

安装后发任意消息，朱批录会发一条说明。图片识别使用 OpenClaw 已配置的模型，无需额外设置。

---

## 数据结构

所有数据存储在本地：

```
~/.openclaw/skills/kaogong-study-tracker/data/
├── config.json              ← 模型配置（setup_done + model）
├── daily/
│   ├── 2026-03-15.json      ← 每天的套题成绩
│   ├── 2026-03-16.json
│   └── ...
├── wrong_questions.json     ← 所有错题（累积）
├── stats_cache.json         ← 7日模块准确率、连续打卡天数
└── exports/
    └── 备考记录_2026-03-17.xlsx
```

错题记录的完整字段：

```json
{
  "id": "uuid",
  "date": "2026-03-17",
  "source": "image",
  "module": "判断推理",
  "subtype": "图形推理",
  "question_text": "3×3九宫格，箭头叠加规律……",
  "visual_description": "每行第3个图形等于第1、2个图形的箭头叠加，重复箭头消去……",
  "answer": "A",
  "user_annotation": "没看出规律",
  "error_reason": "知识点不会",
  "keywords": ["图形推理", "九宫格", "叠加规律"],
  "raw_image_b64": "...",
  "status": "待二刷"
}
```

---

## 文件结构

```
kaogong-study-tracker/
├── SKILL.md                       ← OpenClaw 读取的主文件（含完整流程文档）
├── package.json
├── scripts/
│   ├── onboarding.js              ← 首次安装对话引导
│   ├── parse_input.js             ← 消息解析 + 多模态模型调用
│   ├── update_daily.js            ← 写入每日记录和统计缓存
│   ├── export_xlsx.js             ← 导出 Excel（含截图嵌入，openpyxl）
│   ├── feishu_doc.js              ← 同步到飞书云文档（可选）
│   └── daily_summary.js           ← 定时晚间总结推送
├── references/
│   ├── reply_templates.md         ← 5种回复模板（正常/情绪低/弱点分析等）
│   └── tone_guide.md              ← 语气规范：像朋友，不像 AI 助手
└── assets/
    ├── module_map.json            ← 科目别名映射（"逻辑"→"判断推理" 等）
    ├── config.example.json        ← 飞书云文档配置模板
    └── workspace-example.yaml    ← 飞书/Telegram 接入配置示例
```

---

## 贡献

欢迎 PR，尤其是：

- 其他考试类型的科目映射（军考、选调、教师编……）
- 针对特定模型的识别 prompt 优化
- 飞书云文档同步的稳定性改进
- 英文版 README（方便海外华人使用）

提 Issue 之前可以先看看 [SKILL.md](SKILL.md)，里面有完整的技术流程说明。

---

## 如果这个项目对你有帮助

每年参加公考的人超过两百万，但专门为备考设计的 OpenClaw Skill 几乎是空白。
如果朱批录帮你或朋友把整理错题这件事变得轻松一点——

**⭐ Star 一下，让更多备考的人能找到它**

**🍴 Fork 改成你的考试类型——省考、事业单位、军考都需要类似的工具**

有问题或改进想法，欢迎提 Issue 或直接 PR。

---

## License

MIT © 2026
