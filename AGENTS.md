# 朱批录 Agent Instructions

This repository is a reusable study-tracking skill for civil service exam prep. It is not tied to one host. Agents such as Trae, Cursor, opencode, Hermes, OpenClaw, or any local coding/chat agent can use it by reading `SKILL.md` and calling the scripts in `scripts/`.

## When To Trigger

Use this skill when the user mentions:

- 公考、国考、省考、行测、申论
- 错题、错题本、二刷、复习提醒
- 言语理解、数量关系、判断推理、资料分析
- 导出错题本、生成 Excel、同步飞书
- An uploaded screenshot of an exam question

## Core Flow

1. Text progress input: call `handleMessage()` or `parseStudyInput()` from `scripts/parse_input.js`, then persist with `updateDailyRecord()` from `scripts/update_daily.js`.
2. Image question input: pass the screenshot base64 plus a vision-capable `agentCall` into `parseImageInput()`, then save the returned question with `saveWrongQuestion()`.
3. Export workbook: run `node scripts/export_xlsx.js`; add filters such as `--pending-only`, `--module=判断推理`, or `--days=14` when requested.
4. Daily summary: run `node scripts/daily_summary.js` and send stdout back to the user.
5. Review reminder: run `node scripts/review_reminder.js`; route later “记得 / 不记得” replies through `handleMessage()`.

## Local Data

Data is local-first. By default it lives in:

```bash
~/.kaogong-study-tracker/data
```

Override it with:

```bash
KAOGONG_DATA_DIR=/path/to/data
```

## Image Capability

Screenshot recognition depends on the host agent. If the current model cannot accept images, ask the user to paste the question text and continue with the text flow.

Keep replies short, concrete, and friendly. Follow `references/tone_guide.md`.
