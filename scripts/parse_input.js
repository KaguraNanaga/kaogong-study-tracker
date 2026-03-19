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
const { handleReviewReply } = require('./review_reminder');


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

async function parseImageInput(imageBase64, caption, agentCall) {
  // agentCall 是 OpenClaw 注入的模型调用函数（使用 workspace 里配置的模型）
  // 如果没有注入（模型不支持图片），直接返回降级提示
  if (typeof agentCall !== 'function') {
    return {
      success:         false,
      error:           'no_vision',
      fallback_prompt: '没识别出来，可以把题目文字复制过来发给我，一样能整理。',
    };
  }

  let engineResult;
  try {
    const promptWithCaption = caption
      ? `${MULTIMODAL_PROMPT}\n\n用户附带说明：「${caption}」`
      : MULTIMODAL_PROMPT;
    const raw    = await agentCall({ image: imageBase64, text: promptWithCaption });
    const parsed = JSON.parse((raw || '').replace(/```json|```/g, '').trim());
    if (parsed.error) throw new Error(parsed.error);
    engineResult = {
      success:            true,
      source_engine:      'openclaw-agent',
      module:             normalizeModule(parsed.module) ?? parsed.module,
      subtype:            parsed.subtype             ?? '未识别',
      question_text:      parsed.question_text       ?? '',
      visual_description: parsed.visual_description  ?? null,
      answer:             parsed.answer              ?? null,
      user_annotation:    parsed.user_annotation     ?? null,
      error_reason:       parsed.error_reason_hint   ?? '未说明',
      keywords:           parsed.keywords            ?? [],
    };
  } catch (e) {
    return {
      success:         false,
      error:           e.message,
      fallback_prompt: '没识别出来，可以把题目文字复制过来发给我，一样能整理。',
    };
  }

  return {
    ...engineResult,
    date:          new Date().toISOString().slice(0, 10),
    source:        'image',
    raw_image_b64: await compressImageAsync(imageBase64),  // 压缩到 800px 宽再存
    needs_confirm: buildConfirmPrompt(engineResult.module, engineResult.error_reason, caption),
  };
}


// ─────────────────────────────────────────────
// 图片压缩（存储前缩至 800px 宽，减少 JSON 体积）
// ─────────────────────────────────────────────

/**
 * 用 Canvas API（Node 18+ 没有，走 sharp 或直接限制尺寸）。
 * OpenClaw 运行在 Node 环境，这里用 sharp 如果可用，否则原样返回。
 * 安装：npm install sharp（可选，未安装时跳过压缩）
 */
function compressImage(base64) {
  try {
    const sharp = require('sharp');  // 可选依赖，未安装时 catch
    const buf   = Buffer.from(base64, 'base64');
    // sharp 是异步的，这里同步包装（仅在图片很大时才值得）
    // 实际使用时建议改为 async 版本
    return base64;  // 占位，下方 compressImageAsync 是真正的异步版本
  } catch (_) {
    return base64;  // sharp 未安装，原样返回
  }
}

/**
 * 异步版本（推荐在 parseImageInput 中使用）。
 * 将图片压缩到宽度 ≤800px，质量 80，减少存储体积约 60-80%。
 */
async function compressImageAsync(base64) {
  try {
    const sharp  = require('sharp');
    const buf    = Buffer.from(base64, 'base64');
    const out    = await sharp(buf)
      .resize({ width: 800, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return out.toString('base64');
  } catch (_) {
    return base64;  // sharp 未安装或压缩失败，原样返回
  }
}

// ─────────────────────────────────────────────
// 快捷录入模式
// ─────────────────────────────────────────────

/**
 * 识别快捷格式：「科目-题型-原因-状态」
 * 例：资料-乘积增长-公式不熟-待二刷
 *     判断-逻辑判断-粗心
 *     言语-主旨-没时间
 *
 * @returns {object|null} 解析结果，null 表示不是快捷格式
 */
function parseQuickEntry(text) {
  // 快捷格式：至少两段用 - 或 — 分隔，第一段是科目关键词
  const parts = text.split(/[-—·\/]/);
  if (parts.length < 2) return null;

  const module = normalizeModule(parts[0].trim());
  if (!module) return null;

  // 第二段：题型（可选）
  const subtype = parts[1]?.trim() || '';

  // 第三段：原因（可选，做关键词匹配）
  const reasonRaw  = parts[2]?.trim() || '';
  const error_reason = inferErrorReason(reasonRaw) !== '未说明'
    ? inferErrorReason(reasonRaw)
    : (reasonRaw || '未说明');

  // 第四段：状态（可选）
  const statusRaw = parts[3]?.trim() || '';
  const status    = /掌握|搞懂|会了/.test(statusRaw) ? '已掌握' : '待二刷';

  // 自动提取知识点标签
  const keywords = extractKeywords(`${subtype} ${reasonRaw}`, module);

  return {
    source:        'quick',
    date:          new Date().toISOString().slice(0, 10),
    module,
    subtype:       subtype || guessSubtype(reasonRaw),
    question_text: text,   // 保留原始快捷文字
    error_reason,
    keywords,
    status,
    needs_confirm: null,   // 快捷模式不追问
  };
}


// ─────────────────────────────────────────────
// 导出筛选指令解析
// ─────────────────────────────────────────────

/**
 * 识别用户是否在请求筛选导出，返回筛选参数或 null。
 * 支持：
 *   "导出错题本" / "导出全部"
 *   "只导出待二刷的"
 *   "导出判断推理的错题"
 *   "导出最近两周的" / "导出最近30天"
 *   "只导出待二刷的资料分析题"
 */
function parseExportCommand(text) {
  if (!/导出|错题本|生成报告/.test(text)) return null;

  const pending = /待二刷|未掌握/.test(text);

  // 科目匹配
  const module = normalizeModule(text);

  // 时间匹配：最近N天 / 最近X周
  let days = null;
  const daysMatch = text.match(/最近\s*(\d+)\s*天/);
  const weeksMatch = text.match(/最近\s*(\d+)\s*周/);
  const monthMatch = text.match(/最近\s*(\d+)\s*个?月/);
  if (daysMatch)  days = parseInt(daysMatch[1]);
  if (weeksMatch) days = parseInt(weeksMatch[1]) * 7;
  if (monthMatch) days = parseInt(monthMatch[1]) * 30;
  // 口语化时间
  if (/上周|这周|本周/.test(text))   days = 7;
  if (/本月|这个月/.test(text))      days = 30;
  if (/两周|两个周/.test(text))      days = 14;

  return { _export: true, pendingOnly: pending, moduleFilter: module, daysFilter: days };
}

// ─────────────────────────────────────────────
// 文字消息处理
// ─────────────────────────────────────────────

function parseStudyInput(message) {
  // 优先尝试快捷录入格式：资料-乘积增长-公式不熟-待二刷
  const quick = parseQuickEntry(message);
  if (quick) return quick;

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

async function handleMessage(message, { agentCall, sendMessage } = {}) {
  const text = message.text ?? message.caption ?? '';

  // 1. 二刷回复拦截（优先级最高，避免"记得"被当成普通消息）
  if (message.type === 'text' && sendMessage) {
    const reviewReply = handleReviewReply(text);
    if (reviewReply !== null) {
      await sendMessage(reviewReply);
      return { _review: true };
    }
  }

  // 2. 图片消息
  if (message.type === 'image') {
    return parseImageInput(message.imageBase64, message.caption ?? '', agentCall);
  }

  // 3. 导出筛选指令
  const exportCmd = parseExportCommand(text);
  if (exportCmd) return exportCmd;

  // 4. 普通文字消息
  return parseStudyInput(text);
}

module.exports = { handleMessage, parseStudyInput, parseImageInput, normalizeModule, detectMood };
