/**
 * parse_input.js
 * 将用户发来的消息（文字 或 图片）解析为结构化的备考数据。
 *
 * 图片识别：统一走多模态模型（在 config.json 中配置）。
 *   支持图形推理、统计图表等 OCR 无法理解的题型。
 *   未配置时发送 onboarding 提示，引导用户填写 API Key。
 *
 * Windows 兼容：execFile 先尝试 python3，失败则 fallback 到 python（导出用）。
 */

const fs           = require('fs');
const path         = require('path');
const { execFile } = require('child_process');
const os           = require('os');
const { handleOnboarding, isSetupDone, getStoredModel } = require('./onboarding');

// ─────────────────────────────────────────────
// 配置加载
// ─────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '../config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch (_) { return {}; }
}


// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

const MODULE_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/module_map.json'), 'utf-8')
);

function normalizeModule(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [standard, aliases] of Object.entries(MODULE_MAP.aliases)) {
    if (aliases.some(a => lower.includes(a.toLowerCase()))) return standard;
  }
  return null;
}

function extractWrongCount(text) {
  const patterns = [
    /错[了了]?\s*(\d+)\s*[道题个]/,
    /(\d+)\s*[道题个]?\s*[错误不对]/,
    /(\d+)\s*错/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function inferErrorReason(text) {
  const reasons = MODULE_MAP.error_reason_keywords;
  for (const [reason, keywords] of Object.entries(reasons)) {
    if (keywords.some(k => text.includes(k))) return reason;
  }
  return '未说明';
}

function detectMood(text) {
  if (/太累|好烦|没用|放弃|崩了/.test(text))      return '低落';
  if (/没时间|来不及|考试快|好焦虑|压力/.test(text)) return '焦虑';
  if (/不错|还行|有进步|感觉好|状态好/.test(text))  return '良好';
  return '中性';
}


// ─────────────────────────────────────────────
// ③ 多模态模型调用（可选，支持图形/图表理解）
// ─────────────────────────────────────────────

const MULTIMODAL_PROMPT = `
你是一个公考备考助手，正在分析用户发来的错题截图。
请从图片中提取以下信息，严格以 JSON 格式返回，不要有任何额外说明。

重要要求：
- 所有字段必须完整输出，禁止使用省略号（...）截断内容
- visual_description 对图形推理、统计图题目必须完整描述，不得省略任何细节
- question_text 对文字题必须包含题干和全部选项的完整文字

{
  "module": "科目，只能是：言语理解/数量关系/判断推理/资料分析/申论 之一",
  "subtype": "题型，如：逻辑判断/图形推理/定义判断/类比推理/数学运算/资料分析-增长率/主旨概括 等",
  "question_text": "【完整输出】文字题：题干+全部选项；图形推理：描述图形规律；统计图：标题+所有数据",
  "visual_description": "【完整输出，不得截断】图形推理/统计图的详细视觉描述：每个格子/数据点的具体内容、规律分析。纯文字题填 null",
  "answer": "正确答案字母，图片中若不可见则填 null",
  "user_annotation": "用户手写批注原文，没有填 null",
  "error_reason_hint": "知识点不会/粗心/时间不够/概念混淆/无法判断",
  "keywords": ["知识点标签，最多3个"]
}

如果图片模糊无法识别，返回：{"error": "图片无法识别"}
`.trim();

function inferProvider(modelName) {
  if (/claude/.test(modelName))                           return 'anthropic';
  if (/gpt|o1|o3|o4/.test(modelName))                    return 'openai';
  if (/gemini/.test(modelName))                           return 'google';
  if (/qwen|tongyi/.test(modelName))                      return 'dashscope';
  if (/kimi|moonshot/.test(modelName))                    return 'moonshot';
  if (/glm|chatglm/.test(modelName))                      return 'zhipu';
  if (/minimax/.test(modelName))                          return 'minimax';
  if (/deepseek/.test(modelName))                         return 'deepseek';
  return 'openai';  // 默认走 OpenAI 兼容接口
}

function inferBaseUrl(provider) {
  const urls = {
    'anthropic':  'https://api.anthropic.com/v1/messages',
    'openai':     'https://api.openai.com/v1/chat/completions',
    'google':     'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    'dashscope':  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'moonshot':   'https://api.moonshot.cn/v1/chat/completions',
    'zhipu':      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'minimax':    'https://api.minimax.chat/v1/text/chatcompletion_v2',
    'deepseek':   'https://api.deepseek.com/v1/chat/completions',
  };
  return urls[provider] || 'https://api.openai.com/v1/chat/completions';
}

async function runMultimodalModel(imageBase64, caption, config) {
  const modelName = (config.multimodal?.model || '').toLowerCase();

  // API key 从 OpenClaw 运行环境取，key 名根据模型推断
  // 用户只需在 OpenClaw 的 workspace 里配好对应的 auth-profile 即可
  const provider = inferProvider(modelName);
  const model    = config.multimodal?.model || 'claude-sonnet-4-6';
  const apiKey   = process.env[`${provider.toUpperCase().replace(/-/g,'_')}_API_KEY`]
                   || process.env.MULTIMODAL_API_KEY
                   || '';
  const baseUrl  = inferBaseUrl(provider);

  const promptWithCaption = caption
    ? `${MULTIMODAL_PROMPT}\n\n用户附带说明：「${caption}」`
    : MULTIMODAL_PROMPT;

  try {
    const headers = { 'Content-Type': 'application/json' };

    // 根据不同提供商设置 header
    if (provider === 'anthropic') {
      headers['x-api-key']         = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Anthropic 用原生格式，其余统一走 OpenAI 兼容格式
    const body = provider === 'anthropic'
      ? {
          model, max_tokens: 3000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: promptWithCaption },
            ],
          }],
        }
      : {
          model, max_tokens: 3000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
              { type: 'text', text: promptWithCaption },
            ],
          }],
        };

    const response = await fetch(baseUrl, {
      method: 'POST', headers,
      body: JSON.stringify(body),
    });
    const data    = await response.json();
    const rawText = provider === 'anthropic'
      ? data.content?.[0]?.text
      : data.choices?.[0]?.message?.content;

    const parsed = JSON.parse((rawText || '').replace(/```json|```/g, '').trim());
    if (parsed.error) return { success: false, error: parsed.error };

    return {
      success:           true,
      source_engine:     `multimodal:${provider}/${model}`,
      module:            normalizeModule(parsed.module) ?? parsed.module,
      subtype:           parsed.subtype            ?? '未识别',
      question_text:     parsed.question_text      ?? '',
      visual_description: parsed.visual_description ?? null,
      answer:            parsed.answer             ?? null,
      user_annotation:   parsed.user_annotation    ?? null,
      error_reason:      parsed.error_reason_hint  ?? '未说明',
      keywords:          parsed.keywords           ?? [],
    };
  } catch (e) {
    return { success: false, error: `多模态模型调用失败: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 图片识别结果 → 统一结构
// ─────────────────────────────────────────────

function buildConfirmPrompt(module, errorReason, caption) {
  if (!module)                                    return '这是哪个科目？（言语/数量/判断/资料/申论）';
  if (errorReason === '未说明' && !caption)       return '这道题是知识点没掌握、粗心，还是时间不够？';
  return null;
}

function guessSubtype(text) {
  if (/图形|图案/.test(text))                              return '图形推理';
  if (/定义|是指|是一种/.test(text))                       return '定义判断';
  if (/对于|就像|之于/.test(text))                         return '类比推理';
  if (/甲.*乙|假言|充分|必要/.test(text))                  return '逻辑判断';
  if (/增长[率速]|同比|环比|占比|百分/.test(text))          return '资料分析-增长率';
  if (/工程|效率|天完成/.test(text))                       return '数学运算-工程';
  if (/速度|相遇|追及/.test(text))                         return '数学运算-行程';
  if (/主旨|意在|核心|观点/.test(text))                    return '言语-主旨概括';
  if (/填入.*恰当|横线|空白/.test(text))                   return '言语-语句填空';
  return '未识别';
}

function cleanQuestionText(lines) {
  return lines
    .filter(l => {
      const t = l.trim();
      return t && !/^\d+$/.test(t) && !/^第\s*\d+\s*题$/.test(t);
    })
    .join(' ')
    .slice(0, 300);
}

function extractAnswer(text) {
  const patterns = [
    /[【\[]?答案[：:]\s*([A-D])[】\]]?/,
    /正确[答案选项]*[：:]\s*([A-D])/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractKeywords(text, module) {
  const km = {
    '判断推理': [['假言命题',/假言|充分条件|必要条件/],['逆否命题',/逆否/],['图形推理',/图形|对称|旋转/],['定义判断',/定义|是指/]],
    '数量关系': [['工程问题',/工程|效率|天完成/],['行程问题',/速度|相遇|追及/],['排列组合',/排列|组合|方案/]],
    '资料分析': [['增长率',/增长率|同比|环比/],['比重',/比重|占比/],['倍数',/倍数|是.*倍/]],
    '言语理解': [['主旨概括',/主旨|核心/],['语句填空',/填入|横线/],['细节判断',/符合原文/]],
  };
  return (km[module] || []).filter(([,p]) => p.test(text)).map(([k]) => k).slice(0, 3);
}

// ─────────────────────────────────────────────
// 图片消息主入口
// ─────────────────────────────────────────────

async function parseImageInput(imageBase64, caption = '') {
  const model = getStoredModel();

  const engineResult = await runMultimodalModel(imageBase64, caption, { multimodal: { model } });
  if (!engineResult.success) {
    return {
      success:         false,
      error:           engineResult.error,
      fallback_prompt: '没识别出来，可以把题目文字复制过来发给我，一样能整理。',
    };
  }

  return {
    ...engineResult,
    date:          new Date().toISOString().slice(0, 10),
    source:        'image',
    raw_image_b64: imageBase64,   // 保留原图，供 xlsx 嵌入使用（见 export_xlsx.js）
    needs_confirm: buildConfirmPrompt(engineResult.module, engineResult.error_reason, caption),
  };
}

// ─────────────────────────────────────────────
// 文字消息处理
// ─────────────────────────────────────────────

function parseStudyInput(message) {
  const result = {
    date:                new Date().toISOString().slice(0, 10),
    source:              'text',
    raw_message:         message,
    mood:                detectMood(message),
    parsed_modules:      {},
    has_exam:            false,
    skip_today:          false,
    needs_clarification: null,
  };

  if (/没做|没时间|跳过|明天补|休息/.test(message)) {
    result.skip_today = true;
    return result;
  }
  if (/做了|做完|刷了|套题|整套|一套/.test(message)) result.has_exam = true;

  for (const sent of message.split(/[，。！？,.\n]/)) {
    const mod = normalizeModule(sent);
    if (mod) {
      result.parsed_modules[mod] = {
        wrong:        extractWrongCount(sent),
        total:        null,
        error_reason: inferErrorReason(sent),
      };
      result.has_exam = true;
    }
  }

  if (result.has_exam && !Object.keys(result.parsed_modules).length) {
    result.needs_clarification = '没太看懂，能说说今天做了哪个科目、错了几道吗？';
  }

  return result;
}

// ─────────────────────────────────────────────
// OpenClaw 统一入口
// ─────────────────────────────────────────────

async function handleMessage(message, { webSearch, sendMessage } = {}) {
  // Onboarding 拦截：setup 未完成，所有消息交给 onboarding
  if (!isSetupDone()) {
    const consumed = await handleOnboarding(
      message.text ?? message.caption ?? '',
      webSearch,
      sendMessage
    );
    if (consumed) return { _onboarding: true };
  }

  if (message.type === 'image') {
    return parseImageInput(message.imageBase64, message.caption ?? '');
  }
  return parseStudyInput(message.text ?? '');
}

module.exports = { handleMessage, parseStudyInput, parseImageInput, normalizeModule, detectMood };
