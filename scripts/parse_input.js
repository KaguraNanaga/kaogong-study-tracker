/**
 * parse_input.js
 * 将用户发来的消息（文字 或 图片）解析为结构化的备考数据。
 *
 * 图片识别：统一走宿主 agent 提供的多模态模型（agentCall）。
 *   支持图形推理、统计图表等 OCR 无法理解的题型。
 *   宿主没有图片能力时，提示用户改发文字。
 */

const fs           = require('fs');
const path         = require('path');
const { handleReviewReply } = require('./review_reminder');
const { todayLocal, normalizeBase64 } = require('./util');


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
  // 顺序很重要："40题错10" 要取 10，不能取 40
  const patterns = [
    /错(?:了)?\s*(\d+)/,                       // 错了8道 / 错10
    /(\d+)\s*[道题个]?\s*(?:错|不对)/,          // 4错 / 3道错了
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** 总题数："40题错10" / "做了40道错了8道" / "15道题错5" */
function extractTotalCount(text) {
  const m = text.match(/(\d+)\s*[道题][题]?[^\d]{0,6}?错/);
  if (!m) return null;
  const total = parseInt(m[1], 10);
  const wrong = extractWrongCount(text);
  return wrong != null && wrong !== total ? total : null;
}

function inferErrorReason(text) {
  if (!text) return '未说明';
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

const MULTIMODAL_PROMPT = fs
  .readFileSync(path.join(__dirname, '../references/vision_prompt.md'), 'utf-8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .trim();


// ─────────────────────────────────────────────
// 图片识别结果 → 统一结构
// ─────────────────────────────────────────────

const REASONS = ['知识点不会', '粗心', '时间不够', '概念混淆'];

function buildConfirmPrompt(module, errorReason) {
  if (!module || !MODULE_MAP.aliases[module]) return '这是哪个科目？（常识/言语/数量/判断/资料/申论）';
  if (!REASONS.includes(errorReason))         return '这道题是知识点没掌握、粗心，还是时间不够？';
  return null;
}

/** 模型经常在 JSON 前后加说明文字或代码块，取第一个 { 到最后一个 } */
function extractJson(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
  return JSON.parse(s.slice(start, end + 1));
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
  // agentCall 是宿主 agent 注入的模型调用函数（需支持图片输入）
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
    const raw    = await agentCall({ image: normalizeBase64(imageBase64), text: promptWithCaption });
    const parsed = extractJson(raw);
    if (parsed.error) throw new Error(parsed.error);
    // 用户在 caption 里说了原因，以用户为准；模型的"无法判断"视为未说明，才会触发追问
    const captionReason = inferErrorReason(caption);
    const modelReason   = REASONS.includes(parsed.error_reason_hint) ? parsed.error_reason_hint : '未说明';
    engineResult = {
      success:            true,
      source_engine:      'agent-vision',
      module:             normalizeModule(parsed.module) ?? parsed.module,
      subtype:            parsed.subtype             ?? '未识别',
      question_text:      parsed.question_text       ?? '',
      visual_description: parsed.visual_description  ?? null,
      answer:             parsed.answer              ?? null,
      user_annotation:    parsed.user_annotation     ?? null,
      error_reason:       captionReason !== '未说明' ? captionReason : modelReason,
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
    date:          todayLocal(),
    source:        'image',
    status:        '待二刷',
    raw_image_b64: await compressImageAsync(normalizeBase64(imageBase64)),  // 压缩到 1200px 宽再存
    needs_confirm: buildConfirmPrompt(engineResult.module, engineResult.error_reason),
  };
}


// ─────────────────────────────────────────────
// 图片压缩（存储前缩至 800px 宽，减少 JSON 体积）
// ─────────────────────────────────────────────

/**
 * 异步版本（推荐在 parseImageInput 中使用）。
 * 将图片压缩到宽度 ≤800px，质量 80，减少存储体积约 60-80%。
 */
async function compressImageAsync(base64) {
  try {
    const sharp  = require('sharp');
    const buf    = Buffer.from(base64, 'base64');
    const out    = await sharp(buf)
      .flatten({ background: '#ffffff' })                  // 透明区域铺白底，否则转 JPEG 会变黑
      .rotate()                                            // 按 EXIF 方向摆正手机照片
      .resize({ width: 1200, withoutEnlargement: true })   // 800 宽时资料分析小字常看不清
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
  // 快捷格式：至少两段用 - 或 — 分隔，且第一段"只是"科目名。
  // 不能只看第一段里"含有"科目词，否则"今天判断错了8道/言语4道"会被当成快捷录入，打卡数据丢失。
  const parts = text.trim().split(/\s*[-—–]\s*/);
  if (parts.length < 2) return null;

  const head = parts[0].trim();
  if (head.length > 7 || /\d/.test(head)) return null;
  const module = normalizeModule(head);
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
    date:          todayLocal(),
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
  // 只认明确的导出意图。原来只要出现"错题本"就算导出，
  // "错题本里那道图推我看懂了"也会触发导出。
  const intent = /导出|生成报告|下载.{0,6}错题|(?:把|将).{0,6}错题.{0,4}(?:发|给|传)(?:给)?我|错题本.{0,2}(?:发|给)(?:给)?我/;
  if (!intent.test(text)) return null;

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
    date:                todayLocal(),
    source:              'text',
    raw_message:         message,
    mood:                detectMood(message),
    parsed_modules:      {},
    has_exam:            false,
    skip_today:          false,
    needs_clarification: null,
    // 更正上一条，而不是又做了一套
    is_correction:       /说错了|记错了|报错了|更正|改成|改为|应该是/.test(message),
  };

  if (/做了|做完|刷了|套题|整套|一套/.test(message)) result.has_exam = true;

  const mentionsWrong = /错|不对/.test(message);
  for (const sent of message.split(/[，。！？；、\/,.;!?\n]/)) {
    const mod = normalizeModule(sent);
    if (!mod) continue;

    if (mod === '申论') {
      // 申论按"写没写"记录，不按错题数
      if (/没写|没做|没练|跳过/.test(sent))       result.parsed_modules[mod] = { written: false };
      else if (/写了|写完|做了|练了|交了/.test(sent)) result.parsed_modules[mod] = { written: true };
      else continue;   // "申论怎么提分"这类提问不算打卡
      result.has_exam = true;
      continue;
    }

    let wrong = extractWrongCount(sent);
    let total = extractTotalCount(sent);
    // 只补总题数："判断那套一共40道"
    const totalOnly = sent.match(/(?:一共|总共|共)\s*(\d+)\s*[道题]/);
    if (wrong == null && totalOnly) total = parseInt(totalOnly[1], 10);
    // "判断错了8道/言语4道"、"更正：判断是6道"：省略了"错"，整句在说错题数时按错题数理解
    if (wrong == null && !totalOnly && (mentionsWrong || result.is_correction)) {
      const nums = sent.match(/\d+/g);
      if (nums && nums.length === 1) wrong = parseInt(nums[0], 10);
    }
    if (wrong == null && total == null && !result.has_exam) continue;   // 只提到科目名、没报数字的问句不记录
    result.parsed_modules[mod] = {
      wrong,
      total,
      error_reason: inferErrorReason(sent),
    };
    result.has_exam = true;
  }

  // 只有在完全没有做题数据时，才把"没做/休息"理解为今天跳过。
  // 否则"判断错了8道，申论没做"会把整天记成休息、错题数全丢。
  if (!Object.keys(result.parsed_modules).length && /没做|没时间|跳过|明天补|休息/.test(message)) {
    result.skip_today = true;
    result.has_exam   = false;
    return result;
  }

  if (result.has_exam && !Object.keys(result.parsed_modules).length) {
    result.needs_clarification = '没太看懂，能说说今天做了哪个科目、错了几道吗？';
  }

  return result;
}

// ─────────────────────────────────────────────
// 通用 agent 入口
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

module.exports = {
  handleMessage, parseStudyInput, parseImageInput, parseExportCommand,
  normalizeModule, inferErrorReason, detectMood, compressImageAsync, REASONS, MULTIMODAL_PROMPT,
};
