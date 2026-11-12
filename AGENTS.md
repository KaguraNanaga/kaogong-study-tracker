# 朱批录 Agent Instructions

This repository is a reusable study-tracking skill for civil service exam prep. It is not tied to one host. Agents such as Trae, Cursor, opencode, Hermes, OpenClaw, or any local coding/chat agent can use it by reading `SKILL.md` and calling the scripts in `scripts/`.

## When To Trigger

Use this skill when the user:

- reports practice results (公考、国考、省考、行测、申论, e.g. "今天判断推理错了8道")
- sends a screenshot or pasted text of an exam question to file as a wrong question (错题)
- answers a review prompt ("记得 / 不记得") or asks to mark a question as mastered
- asks for stats, weak modules, exporting the workbook (导出错题本), or syncing to Feishu

Do not record anything for general chat about exam prep, study-method questions, or images unrelated to exam questions.

## Core Flow

All reads and writes go through `node scripts/cli.js <command>`, which prints one line of JSON. Do not edit files under the data directory yourself.

1. First, run `node scripts/cli.js welcome`; if `first_run` is true, send `message` to the user.
2. Text progress input: `node scripts/cli.js log "<user message>"`, then reply based on the returned `type` (see SKILL.md Step 1).
3. Screenshot or pasted question: extract fields per `references/vision_prompt.md`, write them to a JSON file, then `node scripts/cli.js add-question --json=<file> [--image=<screenshot path>]`. If `needs_confirm` is not null, ask once, then `node scripts/cli.js update-question last --reason=...`.
4. Stats / analysis questions: `node scripts/cli.js stats`.
5. Export workbook: `node scripts/cli.js export [--pending-only] [--module=判断推理] [--days=14]`; send the file on the `ATTACH:` line.
6. Scheduled jobs: `node scripts/cli.js summary` (daily) and `node scripts/cli.js review` (every other day); send `message`. Route "记得 / 不记得" replies to `node scripts/cli.js review-reply "<text>"`.

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
