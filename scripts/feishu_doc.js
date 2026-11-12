/**
 * feishu_doc.js
 * 把错题本同步到飞书云文档（新版文档 docx），截图以图片块嵌入。
 *
 * ── 配置（config.json）──────────────────────────────────────
 *   "feishu_doc": {
 *     "enabled":    true,
 *     "app_id":     "cli_xxxxxx",
 *     "app_secret": "xxxxxxxx",
 *     "doc_url":    "https://xxx.feishu.cn/docx/XXXXXXXX",  // 直接粘贴文档链接即可（也支持 /wiki/ 链接）
 *     "domain":     "feishu"                                 // 国际版 Lark 填 "lark"
 *   }
 *   旧配置里的 "doc_token" 仍然兼容。
 *
 * ── 飞书侧必须做的三件事（大部分"同步失败"都卡在这里）──────
 *   1. 开放平台 → 你的企业自建应用 → 权限管理，开通：
 *        docx:document                      （编辑新版文档）
 *        docs:document.media:upload 或 drive:drive （上传文档图片）
 *        wiki:wiki:readonly                 （仅当用 /wiki/ 链接时需要）
 *   2. 开通权限后「创建版本并发布」，否则权限不生效。
 *   3. 打开目标文档 → 右上角「…」→「添加文档应用」，把这个应用加进来并给"可编辑"。
 *      tenant_access_token 只能访问应用被授权的文档，不加这一步一定报无权限。
 *
 * ── 图片写入流程（飞书官方要求的三步）──────────────────────
 *   ① 在文档里创建一个空的图片块，拿到它的 block_id
 *   ② 调 drive/v1/medias/upload_all 上传图片，parent_type=docx_image，parent_node=图片块 block_id
 *   ③ PATCH 该图片块，replace_image.token = 上传返回的 file_token
 *   注意：im/v1/images（消息图片）返回的 image_key 不能用在文档里。
 *
 * ── 用法 ────────────────────────────────────────────────────
 *   node scripts/feishu_doc.js              同步最近 10 道"还没同步过"的错题
 *   node scripts/feishu_doc.js --limit=30   同步最近 30 道未同步错题
 *   node scripts/feishu_doc.js --all        同步全部未同步错题
 *   node scripts/feishu_doc.js --resync     忽略同步记录，重新追加（会产生重复）
 *   node scripts/feishu_doc.js --check      只检查配置和权限，不写入
 */

const fs   = require('fs');
const path = require('path');
const { getConfigPath, getDataDir } = require('./paths');
const { readJson, writeJsonAtomic, decodeImage } = require('./util');

const DATA_DIR   = getDataDir();
const WQ_PATH    = path.join(DATA_DIR, 'wrong_questions.json');
const STATE_PATH = path.join(DATA_DIR, 'feishu_sync_state.json');

const BLOCK = { TEXT: 2, HEADING2: 4, DIVIDER: 22, IMAGE: 27 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── 配置 ─────────────────────────────────────────────────────

function loadFeishuConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`未找到 ${configPath}。把 assets/config.example.json 复制为 config.json 并填写 feishu_doc 部分。`);
  }
  const fd = readJson(configPath, {}).feishu_doc || {};
  if (!fd.enabled)                    throw new Error('config.json 里 feishu_doc.enabled 不是 true');
  if (!fd.app_id || !fd.app_secret)   throw new Error('config.json 缺少 feishu_doc.app_id / app_secret');
  if (!fd.doc_url && !fd.doc_token)   throw new Error('config.json 缺少 feishu_doc.doc_url（粘贴文档链接即可）');

  const base = fd.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  return { ...fd, base, target: parseDocTarget(fd.doc_url || fd.doc_token) };
}

/** 从链接或 token 识别出文档类型和 token */
function parseDocTarget(input) {
  const s = String(input).trim();
  let m;
  if ((m = s.match(/\/docx\/([A-Za-z0-9]+)/))) return { kind: 'docx', token: m[1] };
  if ((m = s.match(/\/wiki\/([A-Za-z0-9]+)/))) return { kind: 'wiki', token: m[1] };
  if (/\/docs\/[A-Za-z0-9]+/.test(s)) {
    throw new Error('这是旧版文档（/docs/ 链接），飞书 API 已不支持写入。请新建一篇新版文档（链接里是 /docx/）再配置。');
  }
  if (/^[A-Za-z0-9]+$/.test(s)) return { kind: 'docx', token: s };
  throw new Error(`无法识别的文档地址：${s}`);
}

// ─── HTTP ─────────────────────────────────────────────────────

/** 把常见错误翻译成用户能操作的提示 */
function explain(code, msg, httpStatus) {
  const text = `${msg || ''}`.toLowerCase();
  if (code === 99991672 || /scope|permission denied|access denied/.test(text)) {
    return '应用缺少接口权限：去开放平台开通 docx:document 和 docs:document.media:upload（或 drive:drive），然后「创建版本并发布」。';
  }
  if (httpStatus === 403 || /forbidden|no permission|not have permission/.test(text)) {
    return '应用没有这篇文档的编辑权限：打开文档 → 右上角「…」→「添加文档应用」，把应用加进来并给可编辑。';
  }
  if (httpStatus === 404 || /not ?found/.test(text)) {
    return '找不到文档：检查 doc_url 是否正确，国际版 Lark 需设置 "domain": "lark"。';
  }
  if (/app_id|app secret|app_secret|invalid app/.test(text)) {
    return 'app_id 或 app_secret 不正确。';
  }
  return null;
}

class FeishuClient {
  constructor({ base, app_id, app_secret }) {
    Object.assign(this, { base, app_id, app_secret, token: null, lastEdit: 0 });
  }

  async auth() {
    const res  = await fetch(`${this.base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body:    JSON.stringify({ app_id: this.app_id, app_secret: this.app_secret }),
    });
    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`获取飞书 token 失败: ${data.msg}（${explain(data.code, data.msg, res.status) || '检查 app_id / app_secret'}）`);
    }
    this.token = data.tenant_access_token;
  }

  /**
   * 统一请求：自动带 token；限流（HTTP 429 / code 99991400）时退避重试。
   * 文档编辑接口单文档约 3 次/秒，edit=true 的请求之间强制间隔。
   */
  async call(method, url, { json, form, edit = false } = {}, attempt = 0) {
    if (edit) {
      const wait = this.lastEdit + 400 - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastEdit = Date.now();
    }
    const headers = { Authorization: `Bearer ${this.token}` };
    let body;
    if (json) { headers['Content-Type'] = 'application/json; charset=utf-8'; body = JSON.stringify(json); }
    if (form) body = form;

    const res = await fetch(`${this.base}${url}`, { method, headers, body });
    let data;
    try { data = await res.json(); } catch (_) { data = { code: -1, msg: `HTTP ${res.status}` }; }

    if ((res.status === 429 || data.code === 99991400) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return this.call(method, url, { json, form, edit }, attempt + 1);
    }
    if (data.code !== 0) {
      const hint = explain(data.code, data.msg, res.status);
      const err  = new Error(`${method} ${url.split('?')[0]} 失败: [${data.code}] ${data.msg}${hint ? `\n→ ${hint}` : ''}`);
      err.code = data.code;
      throw err;
    }
    return data.data;
  }
}

// ─── 文档操作 ─────────────────────────────────────────────────

async function resolveDocumentId(client, target) {
  if (target.kind === 'docx') return target.token;
  const node = (await client.call('GET', `/open-apis/wiki/v2/spaces/get_node?token=${target.token}`)).node;
  if (node.obj_type !== 'docx') {
    throw new Error(`这个知识库节点是 ${node.obj_type}，不是新版文档（docx），无法写入。`);
  }
  return node.obj_token;
}

/** 在文档根节点末尾追加块，返回创建出的块列表（不传 index 即追加到末尾） */
async function appendBlocks(client, docId, children) {
  if (!children.length) return [];
  const out = [];
  for (let i = 0; i < children.length; i += 50) {            // 单次最多 50 个
    const data = await client.call(
      'POST',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children?document_revision_id=-1`,
      { json: { children: children.slice(i, i + 50) }, edit: true },
    );
    out.push(...(data.children || []));
  }
  return out;
}

async function insertImage(client, docId, b64) {
  const img = decodeImage(b64);
  if (!img) throw new Error('截图数据不是可识别的图片格式');

  // ① 空图片块
  const [block] = await appendBlocks(client, docId, [{ block_type: BLOCK.IMAGE, image: {} }]);
  const blockId = block.block_id;

  // ② 上传素材，挂到这个图片块下
  const form = new FormData();
  form.append('file_name',   `question.${img.ext}`);
  form.append('parent_type', 'docx_image');
  form.append('parent_node', blockId);
  form.append('size',        String(img.buf.length));
  form.append('extra',       JSON.stringify({ drive_route_token: docId }));
  form.append('file',        new Blob([img.buf], { type: img.mime }), `question.${img.ext}`);
  const up = await client.call('POST', '/open-apis/drive/v1/medias/upload_all', { form });

  // ③ 把素材设置到图片块
  await client.call(
    'PATCH',
    `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}?document_revision_id=-1`,
    { json: { replace_image: { token: up.file_token } }, edit: true },
  );
}

// ─── 块构建 ───────────────────────────────────────────────────

function textBlock(content, style = {}) {
  return {
    block_type: BLOCK.TEXT,
    text: { elements: [{ text_run: { content, text_element_style: style } }] },
  };
}

/** 多行文字拆成多个段落块（文本块内不放换行符，避免接口报参数错误） */
function paragraphs(text, prefix = '', style = {}) {
  return String(text)
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map((line, i) => textBlock(i === 0 ? `${prefix}${line}` : line, style));
}

function headerBlocks(q) {
  const mark  = q.status === '已掌握' ? '✅' : '🔲';
  const title = [q.module, q.subtype].filter(Boolean).join('·') || '错题';
  const blocks = [{
    block_type: BLOCK.HEADING2,
    heading2: { elements: [{ text_run: { content: `${mark} [${title}] ${q.date || ''}`.trim() } }] },
  }];
  if (q.question_text) blocks.push(...paragraphs(q.question_text));
  return blocks;
}

function detailBlocks(q) {
  const blocks = [];
  if (q.visual_description) blocks.push(...paragraphs(q.visual_description, '📐 图形描述：', { italic: true }));
  const meta = [
    q.error_reason      && `❌ 原因：${q.error_reason}`,
    q.answer            && `✔️ 答案：${q.answer}`,
    q.keywords?.length  && `🏷 知识点：${q.keywords.join('、')}`,
    (q.analysis || q.user_annotation) && `📝 批注：${q.analysis || q.user_annotation}`,
  ].filter(Boolean);
  if (meta.length) blocks.push(textBlock(meta.join('　　')));
  blocks.push({ block_type: BLOCK.DIVIDER, divider: {} });
  return blocks;
}

// ─── 主流程 ───────────────────────────────────────────────────

async function syncToFeishuDoc({ all = false, limit = 10, resync = false, checkOnly = false } = {}) {
  const cfg    = loadFeishuConfig();
  const client = new FeishuClient(cfg);
  await client.auth();

  const docId = await resolveDocumentId(client, cfg.target);
  const doc   = await client.call('GET', `/open-apis/docx/v1/documents/${docId}`);
  console.log(`[feishu_doc] 目标文档：${doc.document?.title || docId}`);

  if (checkOnly) {
    // 读文档只需要读权限，再试一次写入才能确认"添加文档应用"那一步做了
    await appendBlocks(client, docId, [textBlock(`朱批录连接测试 ${new Date().toLocaleString()}`)]);
    console.log('[feishu_doc] 配置检查通过：能读能写。（文档末尾多了一行测试文字，可以删掉）');
    return { checked: true };
  }

  const questions = readJson(WQ_PATH, []);
  const state     = readJson(STATE_PATH, {});
  const synced    = state[docId] || (state[docId] = {});

  let todo = questions.filter(q => q.id && (resync || !synced[q.id]));
  // 新的在前选出 limit 条，再按时间正序写入，文档里读起来是从旧到新
  todo.sort((a, b) => `${b.date}${b.id}`.localeCompare(`${a.date}${a.id}`));
  if (!all) todo = todo.slice(0, limit);
  todo.reverse();

  if (!todo.length) {
    console.log('[feishu_doc] 没有新的错题需要同步');
    return { synced: 0 };
  }

  console.log(`[feishu_doc] 开始同步 ${todo.length} 道错题...`);
  let ok = 0, imgFailed = 0;
  for (const q of todo) {
    await appendBlocks(client, docId, headerBlocks(q));
    if (q.raw_image_b64) {
      try {
        await insertImage(client, docId, q.raw_image_b64);
      } catch (e) {
        imgFailed++;
        console.warn(`[feishu_doc] 截图上传失败（${q.date} ${q.module}）：${e.message}`);
        await appendBlocks(client, docId, [textBlock('（截图上传失败，见本地错题本）', { italic: true })]);
      }
    }
    await appendBlocks(client, docId, detailBlocks(q));

    synced[q.id] = new Date().toISOString();
    writeJsonAtomic(STATE_PATH, state);       // 每道题写完就记一次，中途失败下次从断点继续
    ok++;
    console.log(`[feishu_doc] 已同步 ${ok}/${todo.length}: ${q.date} ${q.module} ${q.subtype || ''}`);
  }

  console.log(`[feishu_doc] 同步完成：${ok} 道${imgFailed ? `，其中 ${imgFailed} 张截图上传失败` : ''}`);
  return { synced: ok, imgFailed };
}

// ─── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const argv  = process.argv.slice(2);
  const limit = parseInt(argv.find(a => a.startsWith('--limit='))?.split('=')[1], 10) || 10;
  syncToFeishuDoc({
    all:       argv.includes('--all'),
    resync:    argv.includes('--resync'),
    checkOnly: argv.includes('--check'),
    limit,
  }).catch(e => {
    console.error(`[feishu_doc] 同步失败: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { syncToFeishuDoc, parseDocTarget };
