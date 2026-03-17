/**
 * feishu_doc.js
 * 将错题本同步到飞书云文档，支持图片直接嵌入——对图形推理/统计图最有用。
 *
 * 可行性说明：
 *   飞书开放平台提供「云文档 API」，可以程序化创建/更新文档、插入图片块。
 *   图片先上传到飞书文件系统获取 file_token，再作为图片块插入文档。
 *   最终效果：在飞书里直接看到错题截图 + 分析文字，不需要下载 Excel。
 *
 * 前置配置（在 config.json 中填写）：
 *   {
 *     "feishu_doc": {
 *       "enabled": true,
 *       "app_id":     "cli_xxxxxx",
 *       "app_secret": "xxxxxxxx",
 *       "doc_token":  "xxxxxx"   // 飞书文档 URL 中的 token 部分
 *     }
 *   }
 *
 * 获取 app_id / app_secret：飞书开放平台 → 创建企业自建应用 → 权限：docs:doc
 * 获取 doc_token：新建一个飞书文档，URL 中 /wiki/ 或 /docs/ 后面的字符串就是 token
 *
 * 触发方式：用户说"同步到飞书" / "更新飞书错题本"
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR = path.join(os.homedir(), '.openclaw/skills/kaogong-study-tracker/data');
const WQ_PATH  = path.join(DATA_DIR, 'wrong_questions.json');

// ─── 飞书 API 基础 ────────────────────────────────────────────

async function getTenantToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取飞书 Token 失败: ${data.msg}`);
  return data.tenant_access_token;
}

/**
 * 上传图片到飞书，返回 file_token。
 * @param {string} imageBase64
 * @param {string} token  tenant_access_token
 */
async function uploadImage(imageBase64, token) {
  const imgBuffer = Buffer.from(imageBase64, 'base64');

  // 飞书上传接口需要 multipart/form-data
  const FormData = (await import('node:buffer')).Blob
    ? globalThis.FormData   // Node 18+
    : require('form-data'); // 低版本 fallback

  const form = new FormData();
  form.append('image_type', 'message');
  form.append('image', new Blob([imgBuffer], { type: 'image/jpeg' }), 'question.jpg');

  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}` },
    body:    form,
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`图片上传失败: ${data.msg}`);
  return data.data.image_key;
}

// ─── 文档块构建 ───────────────────────────────────────────────

/** 构建一道错题对应的飞书文档块列表（文字 + 可选图片）。 */
function buildQuestionBlocks(q, imageKey) {
  const statusEmoji = q.status === '已掌握' ? '✅' : '🔲';
  const blocks = [];

  // 标题块：科目 + 题型 + 状态
  blocks.push({
    block_type: 3,   // heading2
    heading2: {
      elements: [{
        type: 'text_run',
        text_run: {
          content: `${statusEmoji} [${q.module}·${q.subtype}] ${q.date}`,
          text_element_style: { bold: true },
        },
      }],
    },
  });

  // 题目内容（如果有）
  if (q.question_text) {
    blocks.push({
      block_type: 2,   // text
      text: {
        elements: [{ type: 'text_run', text_run: { content: q.question_text } }],
        style:    {},
      },
    });
  }

  // 图片块（来自截图）
  if (imageKey) {
    blocks.push({
      block_type: 27,  // image
      image: { token: imageKey, width: 400 },
    });
  }

  // 视觉描述（多模态模型生成的，对图形题有用）
  if (q.visual_description) {
    blocks.push({
      block_type: 2,
      text: {
        elements: [{
          type: 'text_run',
          text_run: {
            content: `📐 图形描述：${q.visual_description}`,
            text_element_style: { italic: true },
          },
        }],
        style: {},
      },
    });
  }

  // 分析 / 知识点
  const meta = [
    q.error_reason  && `❌ 原因：${q.error_reason}`,
    q.answer        && `✔️ 答案：${q.answer}`,
    q.keywords?.length && `🏷 知识点：${q.keywords.join('、')}`,
    q.analysis      && `📝 分析：${q.analysis}`,
  ].filter(Boolean).join('　　');

  if (meta) {
    blocks.push({
      block_type: 2,
      text: {
        elements: [{ type: 'text_run', text_run: { content: meta } }],
        style:    {},
      },
    });
  }

  // 分隔线
  blocks.push({ block_type: 22 });

  return blocks;
}

// ─── 插入文档块 ───────────────────────────────────────────────

async function appendBlocksToDoc(docToken, blocks, token) {
  // 先获取文档末尾 block id
  const docRes = await fetch(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${docToken}/blocks?page_size=500`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const docData = await docRes.json();
  if (docData.code !== 0) throw new Error(`获取文档结构失败: ${docData.msg}`);

  const items    = docData.data?.items ?? [];
  const lastBlock = items[items.length - 1];
  const parentId  = docData.data?.document?.document_id ?? docToken;
  const index     = lastBlock ? items.length : 0;

  const insertRes = await fetch(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${docToken}/blocks/${parentId}/children`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ children: blocks, index }),
    }
  );
  const insertData = await insertRes.json();
  if (insertData.code !== 0) throw new Error(`插入文档块失败: ${insertData.msg}`);
  return insertData;
}

// ─── 主同步函数 ───────────────────────────────────────────────

/**
 * 把最新 N 条错题同步到飞书云文档。
 * @param {{ recentOnly?: boolean, limit?: number }} options
 */
async function syncToFeishuDoc({ recentOnly = true, limit = 10 } = {}) {
  const configPath = path.join(__dirname, '../config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('未找到 config.json，请先配置飞书参数（见 assets/config.example.json）');
  }
  const config    = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const fdConfig  = config.feishu_doc;
  if (!fdConfig?.enabled || !fdConfig.app_id || !fdConfig.app_secret || !fdConfig.doc_token) {
    throw new Error('飞书云文档未启用或配置不完整，请检查 config.json');
  }

  const { app_id, app_secret, doc_token } = fdConfig;

  let questions = [];
  if (fs.existsSync(WQ_PATH)) {
    questions = JSON.parse(fs.readFileSync(WQ_PATH, 'utf-8'));
  }

  // 只同步最新 limit 条（避免文档过长）
  const toSync = recentOnly
    ? [...questions].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, limit)
    : questions;

  if (!toSync.length) {
    console.log('[feishu_doc] 没有错题需要同步');
    return;
  }

  const token = await getTenantToken(app_id, app_secret);
  console.log(`[feishu_doc] 开始同步 ${toSync.length} 道错题...`);

  for (const q of toSync) {
    let imageKey = null;
    if (q.raw_image_b64) {
      try {
        imageKey = await uploadImage(q.raw_image_b64, token);
      } catch (e) {
        console.warn(`[feishu_doc] 图片上传失败（${q.date} ${q.module}）:`, e.message);
      }
    }
    const blocks = buildQuestionBlocks(q, imageKey);
    await appendBlocksToDoc(doc_token, blocks, token);
    console.log(`[feishu_doc] 已同步: ${q.date} ${q.module} ${q.subtype}`);
  }

  console.log('[feishu_doc] 同步完成');
}

// ─── CLI 入口 ─────────────────────────────────────────────────

if (require.main === module) {
  const recentOnly = !process.argv.includes('--all');
  const limit      = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || 10;
  syncToFeishuDoc({ recentOnly, limit }).catch(e => {
    console.error('[feishu_doc] 同步失败:', e.message);
    process.exit(1);
  });
}

module.exports = { syncToFeishuDoc };
