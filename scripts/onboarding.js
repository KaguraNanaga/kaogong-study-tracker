/**
 * onboarding.js
 * 首次加载时发一条提示，不存任何配置，不问任何问题。
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const FLAG_PATH = path.join(
  os.homedir(),
  '.openclaw/skills/kaogong-study-tracker/.welcomed'
);

function hasWelcomed() {
  return fs.existsSync(FLAG_PATH);
}

function markWelcomed() {
  const dir = path.dirname(FLAG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FLAG_PATH, '1');
}

const WELCOME_MSG =
`朱批录已安装。

直接发文字就能记录，比如"今天判断推理错了8道"。
发截图的话，需要 OpenClaw 配置了支持图片输入的多模态模型才能自动识别。
没有的话也没关系，把题目文字手动复制过来发给我，一样能整理。`;

async function initOnboarding(sendMessage) {
  if (hasWelcomed()) return;
  await sendMessage(WELCOME_MSG);
  markWelcomed();
}

module.exports = { initOnboarding };
