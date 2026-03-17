/**
 * onboarding.js
 * 首次安装引导——问一次模型名，存起来，完事。
 *
 * 流程：
 *   1. Skill 加载时检测 config.setup_done
 *   2. 未完成 → 发一条消息问模型名
 *   3. 用户输入模型名 → 不确定时联网搜索确认
 *   4. 存 { setup_done: true, model: "xxx" }，附带说明失败时可手动输入文字
 *
 * config.json 只有两个字段：setup_done + model，不记录其他任何东西。
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_PATH = path.join(
  os.homedir(),
  '.openclaw/skills/kaogong-study-tracker/config.json'
);

// ─── 配置读写 ─────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (_) {}
  return {};
}

function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ─── 状态 ─────────────────────────────────────────────────────

// onboarding 期间只需要一个中间状态：等待用户输入模型名
// 用户输入后直接存储，不需要更多状态机

function isSetupDone() {
  return !!loadConfig().setup_done;
}

function getStoredModel() {
  return loadConfig().model || null;
}

// ─── 联网搜索验证（可选，用户说"不确定"时触发） ───────────────

/**
 * 搜索模型是否支持多模态，返回简短结论给用户。
 * 只在用户主动表示不确定时调用，不强制验证。
 */
async function searchModelInfo(modelName, webSearch) {
  try {
    const results = await webSearch(`"${modelName}" 多模态 图片识别 vision`);
    const text    = JSON.stringify(results).toLowerCase();
    const hit     = ['vision', '图片', 'multimodal', '多模态', 'image input', '-vl', '视觉', '识图']
      .some(k => text.includes(k));
    return hit
      ? `搜到了，「${modelName}」支持图片识别。`
      : `没找到明确信息，但你可以直接告诉我它支持看图，我就按这个用。`;
  } catch (_) {
    return `搜索暂时失败，你直接确认一下它支持看图就行。`;
  }
}

// ─── 消息模板 ─────────────────────────────────────────────────

const MSG_WELCOME = `题爪已安装。

发截图前先告诉我你用什么多模态模型？直接输入名字就行，比如 qwen3-vl、kimi-k2.5、claude-sonnet-4-6……

不确定也没关系，把模型名发过来，我帮你查一下。`;

const MSG_DONE = (model) =>
`好，记住了，用「${model}」识别截图。

之后直接发错题截图就行。如果哪次识别失败，把题目文字复制过来发给我，一样能整理。`;

const MSG_CONFIRM_UNKNOWN = (model, searchResult) =>
`${searchResult}

你确认「${model}」支持看图吗？确认的话直接回复"确认"，我就用它了。`;

// ─── 主处理函数 ───────────────────────────────────────────────

/**
 * 处理 onboarding 期间的用户消息。
 * @returns {boolean} true = 消息已被 onboarding 消费，不继续正常流程
 */
async function handleOnboarding(userMessage, webSearch, sendMessage) {
  if (isSetupDone()) return false;

  const text = (userMessage || '').trim();
  const cfg  = loadConfig();

  // 用户在等待确认状态下回复"确认"
  if (cfg._pending_model && (text.includes('确认') || text === '是' || text === 'yes')) {
    saveConfig({ setup_done: true, model: cfg._pending_model });
    await sendMessage(MSG_DONE(cfg._pending_model));
    return true;
  }

  // 用户输入了模型名（任意非空文字都视为模型名）
  if (text) {
    const uncertain = /不知道|不确定|忘了|帮我查|查一下/.test(text);

    if (uncertain) {
      // 用户说不确定，但没给模型名——再问一次
      await sendMessage('你常用的模型叫什么名字？发过来我帮你搜一下。');
      return true;
    }

    // 有模型名，先存为 pending，搜一下
    const modelName    = text;
    const searchResult = await searchModelInfo(modelName, webSearch);
    const confirmed    = searchResult.includes('支持图片识别');

    if (confirmed) {
      saveConfig({ setup_done: true, model: modelName });
      await sendMessage(MSG_DONE(modelName));
    } else {
      // 没搜到明确结论，让用户确认一下
      saveConfig({ setup_done: false, _pending_model: modelName });
      await sendMessage(MSG_CONFIRM_UNKNOWN(modelName, searchResult));
    }
    return true;
  }

  // 没有文字内容（第一次加载），发欢迎消息
  await sendMessage(MSG_WELCOME);
  return true;
}

/**
 * Skill 加载时调用。未完成引导则发欢迎消息。
 */
async function initOnboarding(sendMessage) {
  if (isSetupDone()) return;
  await sendMessage(MSG_WELCOME);
}

module.exports = { initOnboarding, handleOnboarding, isSetupDone, getStoredModel };
