/**
 * onboarding.js
 * 首次安装引导：只问两件事——模型名 + API Key。
 *
 * config.json 最终结构：
 *   { setup_done: true, model: "qwen3-vl", api_key: "sk-xxx" }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_PATH = path.join(
  os.homedir(),
  '.openclaw/skills/kaogong-study-tracker/config.json'
);

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

function isSetupDone() { return !!loadConfig().setup_done; }
function getStoredModel() { return loadConfig().model || null; }

// ─── 搜索验证 ─────────────────────────────────────────────────

async function searchModelInfo(modelName, webSearch) {
  try {
    const results = await webSearch(`"${modelName}" 多模态 图片识别 vision`);
    const text    = JSON.stringify(results).toLowerCase();
    return ['vision', '图片', 'multimodal', '多模态', 'image input', '-vl', '视觉', '识图']
      .some(k => text.includes(k));
  } catch (_) {
    return null;
  }
}

// ─── 消息模板 ─────────────────────────────────────────────────

const MSG = {
  WELCOME: `题爪已安装。

发截图识别错题需要一个支持图片输入的多模态模型，先做个简单配置。

第一步：你用什么模型？发名字过来，比如：
  qwen3-vl、kimi-k2.5、glm-4v、claude-sonnet-4-6……

不确定的话发模型名，我帮你查。`,

  SEARCHING: (m) => `搜一下「${m}」是否支持图片识别……`,

  ASK_API_KEY: (m) => `「${m}」支持图片识别。

第二步：把这个模型的 API Key 发给我（只存在本地 config.json）：`,

  DONE: (m) => `配置完成，用「${m}」识别截图。

直接发错题截图就行。`,

  NOT_MULTIMODAL: (m) => `「${m}」好像不支持图片识别。

换一个支持的模型，比如：
  qwen3-vl（阿里通义）、kimi-k2.5（Moonshot）、glm-4v（智谱）
  claude-sonnet-4-6、gpt-5.2（需代理）

把新的模型名发过来：`,

  SEARCH_UNCERTAIN: (m) => `没搜到「${m}」的明确信息。

它支持图片输入吗？
  回复"支持" → 继续配置
  回复其他模型名 → 换一个`,
};

// ─── 主处理函数 ───────────────────────────────────────────────

async function handleOnboarding(userMessage, webSearch, sendMessage) {
  if (isSetupDone()) return false;

  const text = (userMessage || '').trim();
  const cfg  = loadConfig();
  const step = cfg._step || 'wait_model';

  if (step === 'wait_model') {
    if (!text) {
      await sendMessage(MSG.WELCOME);
      saveConfig({ _step: 'wait_model' });
      return true;
    }

    if (text === '支持' && cfg._pending_model) {
      saveConfig({ ...cfg, _step: 'wait_api_key' });
      await sendMessage(MSG.ASK_API_KEY(cfg._pending_model));
      return true;
    }

    const modelName = text;
    await sendMessage(MSG.SEARCHING(modelName));
    const result = await searchModelInfo(modelName, webSearch);

    if (result === true) {
      saveConfig({ _step: 'wait_api_key', _pending_model: modelName });
      await sendMessage(MSG.ASK_API_KEY(modelName));
    } else if (result === false) {
      await sendMessage(MSG.NOT_MULTIMODAL(modelName));
    } else {
      saveConfig({ _step: 'wait_model', _pending_model: modelName });
      await sendMessage(MSG.SEARCH_UNCERTAIN(modelName));
    }
    return true;
  }

  if (step === 'wait_api_key') {
    if (!text) {
      await sendMessage(MSG.ASK_API_KEY(cfg._pending_model || ''));
      return true;
    }
    saveConfig({
      setup_done: true,
      model:      cfg._pending_model || '',
      api_key:    text,
    });
    await sendMessage(MSG.DONE(cfg._pending_model));
    return true;
  }

  return false;
}

async function initOnboarding(sendMessage) {
  if (isSetupDone()) return;
  await sendMessage(MSG.WELCOME);
  saveConfig({ _step: 'wait_model' });
}

module.exports = { initOnboarding, handleOnboarding, isSetupDone, getStoredModel };
