/**
 * 冒烟测试：覆盖之前出过问题的解析、二刷、统计、导出逻辑。
 * 运行：npm test（导出部分需要本机有 python3 + openpyxl + pillow，缺了会跳过）
 */
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaogong-test-'));
process.env.KAOGONG_DATA_DIR = dir;

const { parseStudyInput } = require('../scripts/parse_input');
const { classifyReply }   = require('../scripts/review_reminder');
const { updateDailyRecord, updateStatsCache, saveWrongQuestion } = require('../scripts/update_daily');
const { addDays } = require('../scripts/util');
const { parseDocTarget } = require('../scripts/feishu_doc');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('解析');
t('"申论没做"不会把整天记成休息', () => {
  const r = parseStudyInput('今天判断推理错了8道，申论没做');
  assert.strictEqual(r.skip_today, false);
  assert.strictEqual(r.parsed_modules['判断推理'].wrong, 8);
  assert.strictEqual(r.parsed_modules['申论'].written, false);
});
t('"40题错10"取错题数 10、总数 40', () => {
  const m = parseStudyInput('判断推理40题错10').parsed_modules['判断推理'];
  assert.deepStrictEqual([m.wrong, m.total], [10, 40]);
});
t('带 / 的打卡不会被当成快捷录入', () => {
  const r = parseStudyInput('今天判断推理错了8道/言语4道');
  assert.strictEqual(r.source, 'text');
  assert.strictEqual(r.parsed_modules['言语理解'].wrong, 4);
});
t('"帮我分析一下"不会被识别成申论', () => {
  assert.deepStrictEqual(parseStudyInput('帮我分析一下最近哪个模块最弱').parsed_modules, {});
});
t('常识判断能识别', () => {
  assert.strictEqual(parseStudyInput('常识6错').parsed_modules['常识判断'].wrong, 6);
});
t('快捷格式仍然可用', () => {
  const r = parseStudyInput('资料-乘积增长-公式不熟-待二刷');
  assert.strictEqual(r.source, 'quick');
  assert.strictEqual(r.module, '资料分析');
});

console.log('二刷');
t('"不记得""不知道""不对"判为没记住', () => {
  for (const s of ['不记得', '不知道', '不对', '不太记得了']) assert.strictEqual(classifyReply(s), 'forget', s);
});
t('正常聊天不会被当成二刷回复', () => {
  assert.strictEqual(classifyReply('对了，今天判断错了8道'), null);
});

console.log('统计');
t('一天多条消息只算一天', () => {
  for (const d of ['2026-10-30', '2026-10-31']) {
    for (let i = 1; i <= 3; i++) updateDailyRecord({ ...parseStudyInput(`判断错了${i}道`), date: d });
  }
  const c = updateStatsCache('2026-10-31');
  assert.strictEqual(c.streak, 2);
  assert.strictEqual(c.total_days_studied, 2);
});
t('一天做两套累加；重复写入不重复累加；更正替换最近一套', () => {
  const d = '2026-11-01';
  const say = m => updateDailyRecord({ ...parseStudyInput(m), date: d }).modules['判断推理'];
  say('上午一套，判断错了8道');
  say('上午一套，判断错了8道');                       // agent 重试，同一句
  let m = say('下午又做了一套，判断推理40题错6');
  assert.deepStrictEqual([m.wrong, m.sets.length], [14, 2]);
  m = say('更正：判断是5道');
  assert.deepStrictEqual([m.wrong, m.sets.length, m.sets[1].total], [13, 2, 40]);
});
t('日期加减跨月正确', () => {
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
});
t('错题本损坏时拒绝写入，而不是覆盖', () => {
  const wq = path.join(dir, 'wrong_questions.json');
  fs.writeFileSync(wq, '[{"id":"1"},');
  assert.throws(() => saveWrongQuestion({ module: '判断推理' }));
  assert.strictEqual(fs.readFileSync(wq, 'utf-8'), '[{"id":"1"},');
  fs.unlinkSync(wq);
});

console.log('飞书');
t('识别 docx / wiki 链接，拒绝旧版 docs', () => {
  assert.deepStrictEqual(parseDocTarget('https://x.feishu.cn/docx/AbC123?from=a'), { kind: 'docx', token: 'AbC123' });
  assert.deepStrictEqual(parseDocTarget('https://x.feishu.cn/wiki/WkT9'), { kind: 'wiki', token: 'WkT9' });
  assert.throws(() => parseDocTarget('https://x.feishu.cn/docs/doccnOld'));
});

console.log('命令行');
const { execFileSync } = require('child_process');
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '../scripts/cli.js'), ...args],
  { env: { ...process.env, KAOGONG_DATA_DIR: path.join(dir, 'cli'), KAOGONG_WELCOME_FLAG: path.join(dir, 'cli', '.w') }, encoding: 'utf-8' }).trim().split('\n').pop());
t('welcome 只返回一次欢迎语', () => {
  assert.strictEqual(cli('welcome').first_run, true);
  assert.strictEqual(cli('welcome').first_run, false);
});
t('log：打卡、闲聊不记录、导出意图', () => {
  assert.strictEqual(cli('log', '今天判断推理错了8道').type, 'daily_logged');
  assert.strictEqual(cli('log', '我好累啊').type, 'nothing_recorded');
  assert.strictEqual(cli('log', '错题本里那道图推我看懂了').type, 'nothing_recorded');
  assert.strictEqual(cli('log', '只导出待二刷的').type, 'export_request');
});
t('add-question → needs_confirm → update-question last', () => {
  const f = path.join(dir, 'q.json');
  fs.writeFileSync(f, '识别结果：```json\n{"module":"判断","visual_description":"九宫格","error_reason_hint":"无法判断"}\n```');
  const r = cli('add-question', `--json=${f}`);
  assert.strictEqual(r.question.module, '判断推理');
  assert.ok(r.needs_confirm);
  assert.strictEqual(cli('update-question', 'last', '--reason=这题看错了').question.error_reason, '粗心');
  assert.strictEqual(cli('list-questions', '--pending').total, 1);
});
t('stats 能返回距上次学习天数', () => {
  const s = cli('stats');
  assert.strictEqual(s.days_since_last_study, 0);
  assert.strictEqual(s.questions.pending, 1);
});

(async () => {
  console.log('导出');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  fs.writeFileSync(path.join(dir, 'wrong_questions.json'), JSON.stringify([
    { id: 'a', date: '2026-10-31', module: '判断推理', question_text: '含控制字符\u000b', raw_image_b64: `data:image/png;base64,${png}` },
    { id: 'b', date: '2026-10-31', module: '言语理解', question_text: '=SUM(A1)', raw_image_b64: 'bm90IGFuIGltYWdl' },
  ]));
  try {
    const out = await require('../scripts/export_xlsx').exportXlsx();
    assert.ok(fs.existsSync(out));
    passed++; console.log('  ✓ 控制字符、data URL 前缀、坏图、= 开头文本都能导出');
  } catch (e) {
    if (/找不到 Python|openpyxl/.test(e.message)) console.log(`  - 跳过：${e.message}`);
    else throw e;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} 项通过`);
})().catch(e => { console.error(e); process.exit(1); });
