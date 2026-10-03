#!/usr/bin/env node
/**
 * standalone/server.mjs —— 本地「宿主契约」服务（脱离 DSH 的关键件）
 * ============================================================================
 * 作用：把原本由 DSH 宿主提供的 /dsh-pet-7340/* 端点，用本地 HTTP 服务复刻出来，
 * 让官方的桌面 Helper（runtime/electron-helper）在**没有 DSH** 的情况下照常运行。
 *
 * 复刻的端点（与上游 scripts/dev/mock-server.mjs 同一契约，并补齐它缺的部分）：
 *   GET  /dsh-pet-7340/config                    成品配置聚合 { main: <config.jsonc 解析结果> }
 *   GET  /dsh-pet-7340/thumb/<素材根>/<名>.webm  动画素材（assets/webm）——素材根段按上游规则剥除
 *   GET  /dsh-pet-7340/font/<名>.ttf             气泡字体（assets/fonts）
 *   GET  /dsh-pet-7340/pic/memes/<名>.png        表情包配图（assets/memes）
 *   GET  /dsh-pet-7340/pic/<名>                  光标等图标（assets/pic）
 *   GET  /dsh-pet-7340/sound/<名>.mp3            点击音效（standalone/sound，本版新增）
 *   GET  /dsh-pet-7340/state                     统一状态 S：{ sections: { balance }, pets: { <id>: { say } } }
 *   POST /dsh-pet-7340/balance                   立即刷新余额（递增计数器 = 触发一次余额动画+气泡）
 *   POST /dsh-pet-7340/whisper?pet=<id>          写一条本地碎碎念进 pets.<id>.say
 *   POST /dsh-pet-7340/chat                      （本版无 LLM）返回 ok:false
 *   POST /dsh-pet-7340/reload                    空实现（本版无宿主可重启）
 *
 * 与上游 mock-server.mjs 的三处关键差异（它做不到脱离 DSH）：
 *   ① 它只服务 main 一个条目、把 petId 段剥掉；这里按真实规则分派，且补齐
 *      /font/上首软糖体.ttf、/pic/cursor-grab.png、/pic/cursor-grabbing.png 三个被它漏掉的真实路由；
 *   ② 它不实现 /state —— 而余额**只从 /state 读**（/balance 只是"请刷新"的动作端点），
 *      所以没有 /state 就没有余额气泡；
 *   ③ 它把余额写死成 11.06；这里真的去查 DeepSeek 官方接口。
 *
 * 余额口径（与 dsh-pet 原生一致，见 src/shared/balance.ts）：
 *   余额由 deepseekPricingTier() 折算峰/谷并着色，档位 index = p===100 ? 5 : floor(p/20)，
 *   p = 已用百分比 = 100 − min(100, total/¥20×100)。
 *
 * 用法：
 *   node standalone/server.mjs            # 单独起服务（固定端口 8231），便于调试
 *   或由 standalone/app/main.cjs 在主进程内 dynamic import 后调用 startServer()（动态端口，推荐）
 *   —— 软件形态下走后者：服务跑在 Electron 主进程里，因此全程没有额外进程、也没有控制台窗口。
 * ============================================================================
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = join(ROOT, 'dsh-pet');
const ASSETS = join(PKG, 'assets');
const WEBM_ROOT = join(ASSETS, 'webm');
const FONT_ROOT = join(ASSETS, 'fonts');
const PIC_ROOT = join(ASSETS, 'pic');
const MEME_ROOT = join(ASSETS, 'memes');
// 音效不属于上游素材，是本版新增（见 standalone/sound/），故指向 HERE 而非 PKG
const SOUND_ROOT = join(HERE, 'sound');
const CONFIG_FILE = join(HERE, 'config.jsonc');
const CRED_FILE = join(HERE, 'credential.json');

const PREFIX = '/dsh-pet-7340';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

// ---------------------------------------------------------------------------
// JSONC：剥注释（与上游 host readAllConfig 的 stripJsonc 同规则）
// ---------------------------------------------------------------------------
const stripJsonc = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

function loadConfig() {
  const raw = readFileSync(CONFIG_FILE, 'utf8');
  return JSON.parse(stripJsonc(raw));
}

// ---------------------------------------------------------------------------
// 凭证：按优先级取 API Key
//   1) 环境变量 DSH_PET_DEEPSEEK_KEY
//   2) standalone/credential.json 的 api_key
// 两者都空 -> /state 写 ok:false / credential-missing（宠物会弹「缺少余额查询凭证」）
// ---------------------------------------------------------------------------
function readApiKey() {
  const fromEnv = String(process.env.DSH_PET_DEEPSEEK_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const j = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
    return String(j?.api_key || '').trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 本地碎碎念句库（无 LLM 依赖；右键菜单「碎碎念」用它应答）
// ---------------------------------------------------------------------------
const WHISPER_LINES = [
  '今天的桌面也很安静呢……',
  '主人又在忙什么呀？',
  '偷偷伸个懒腰，没被发现吧。',
  '这个屏幕好亮，眼睛有点酸。',
  '要不要休息一下？我陪你待着。',
  '肚子有点饿了……想吃点什么。',
  '别一直盯着我啦，会害羞的。',
  '刚才那阵风是不是你在动呀？',
  '整理了一下裙摆，好看吗？',
  '好无聊哦，什么时候来找我玩。',
  '我什么也没干，真的。',
  '喝口水的功夫，我又想你了。',
  '桌角好凉，我挪过来一点点。',
  '今天也要开开心心的哦。',
  '要不要给你唱一首歌？',
  '窗外天好像暗了，记得开灯。',
  '偷偷数了一下，今天你已经坐很久了。',
  '轻轻叹口气……没有什么事。',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------------------------------------------------------------------------
// 状态（S）
//   sections.balance = { counter, data }  —— data 就是上游 host 的 BalanceResult 同构体
//   pets.<id>.say    = { counter, data: { text, image? } }
// ---------------------------------------------------------------------------
function createState(cfg) {
  const petsList = Array.isArray(cfg?.pets) ? cfg.pets : [];
  const primaryPetId = String(petsList[0]?.id || 'main');
  const memeKeys = Object.keys(cfg?.memes || {});
  const refreshSec = Number(cfg?.eventsRefreshSec?.balance);
  const balanceRefreshMs = (Number.isFinite(refreshSec) && refreshSec > 0 ? refreshSec : 1800) * 1000;

  return {
    primaryPetId,
    memeKeys,
    balanceRefreshMs,
    balanceCounter: 0,
    /** 最近的余额结果（null = 还没查过） */
    balanceData: null,
    petSay: {}, // petId -> { counter, data }
    saySeq: 0,
    timer: null,
    lastWhisperAt: 0,
  };
}

/** 查一次 DeepSeek 余额，产出与上游 host/balance.ts 的 BalanceResult 同构的对象 */
async function queryBalance() {
  const key = readApiKey();
  if (!key) {
    return {
      ok: false,
      provider: 'deepseek',
      reason: 'credential-missing',
      message: '缺少凭证 deepseek.apiKey（请在 standalone/credential.json 里填入 api_key，或运行「设置密钥.cmd」）',
    };
  }
  try {
    const res = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        provider: 'deepseek',
        reason: 'fetch-error',
        message: `HTTP ${res.status}${body ? ' ' + body.slice(0, 200) : ''}`,
      };
    }
    const j = await res.json();
    if (j && j.is_available === false) {
      return { ok: false, provider: 'deepseek', reason: 'fetch-error', message: '账户当前不可用（is_available=false）' };
    }
    const list = Array.isArray(j?.balance_infos) ? j.balance_infos : [];
    const info = list.find((x) => String(x?.currency || '').toUpperCase() === 'CNY') || list[0];
    if (!info) {
      return { ok: false, provider: 'deepseek', reason: 'fetch-error', message: '响应缺少 balance_infos' };
    }
    return {
      ok: true,
      provider: 'deepseek',
      kind: 'deepseek',
      data: {
        currency: String(info.currency ?? 'CNY'),
        total: String(info.total_balance ?? '0'),
        granted: String(info.granted_balance ?? '0'),
        toppedUp: String(info.topped_up_balance ?? '0'),
      },
    };
  } catch (e) {
    return { ok: false, provider: 'deepseek', reason: 'fetch-error', message: String(e?.message || e) };
  }
}

/** 刷新余额并**递增计数器**（= 让渲染端这一拍渲染余额气泡 + 档位动画） */
async function refreshBalance(st, { manual = false } = {}) {
  const result = await queryBalance();
  st.balanceData = manual ? { ...result, manual: true } : result;
  st.balanceCounter += 1;
  return result;
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
};

/** 把 URL 的 pathname 段安全映射到某个素材根下的文件；越界/不存在返回 null */
function safeResolve(root, relSegments) {
  const candidate = normalize(join(root, ...relSegments));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

function streamFile(req, res, file, contentType, maxAge) {
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end('asset not found');
    return;
  }
  const { size } = statSync(file);
  const headers = {
    'content-type': contentType,
    'content-length': size,
    'cache-control': `public, max-age=${maxAge}`,
    'access-control-allow-origin': '*',
  };
  // <video> 拖动进度/重新加载会带 Range：这里统一按 200 全量返回（本地磁盘，代价可忽略）
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

const readBody = (req) =>
  new Promise((done) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => done(raw));
    req.on('error', () => done(''));
  });

// ---------------------------------------------------------------------------
// 请求分发
// ---------------------------------------------------------------------------
async function handle(req, res, ctx) {
  const { st, cfg } = ctx;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  if (!pathname.startsWith(PREFIX)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('standalone server: not found ' + pathname);
    return;
  }
  const route = pathname.slice(PREFIX.length) || '/';

  // ---- 配置聚合 ----
  if (route === '/config') {
    sendJson(res, 200, { main: cfg });
    return;
  }

  // ---- 统一状态 S ----
  if (route === '/state') {
    const pets = {};
    for (const [id, leaf] of Object.entries(st.petSay)) pets[id] = { say: leaf };
    sendJson(res, 200, {
      sections: {
        balance:
          st.balanceData === null
            ? { counter: 0, data: null } // 还没查过：data=null，渲染端跳过
            : { counter: st.balanceCounter, data: st.balanceData },
      },
      pets,
    });
    return;
  }

  // ---- 余额刷新动作 ----
  if (route === '/balance' && req.method === 'POST') {
    await readBody(req);
    const r = await refreshBalance(st, { manual: true });
    log(`余额刷新（手动）: ${r.ok ? '¥' + r.data.total : '不可用 ' + r.reason}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- 碎碎念（本地句库；无 LLM） ----
  if (route === '/whisper' && req.method === 'POST') {
    await readBody(req);
    const petId = url.searchParams.get('pet') || st.primaryPetId;
    const text = pick(WHISPER_LINES);
    const image = st.memeKeys.length && cfg?.whisperImageEnabled ? pick(st.memeKeys) : '';
    st.saySeq += 1;
    st.petSay[petId] = { counter: st.saySeq, data: { text, image } };
    log(`碎碎念（本地句库）pet=${petId}: ${text}${image ? ' [' + image + ']' : ''}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- 对话（本版无 LLM，明确拒绝，不假装有回复） ----
  if (route === '/chat') {
    await readBody(req);
    sendJson(res, 200, { ok: false, reason: 'no-llm', message: '脱离版未接入模型，对话不可用' });
    return;
  }

  // ---- 重载配置（本版没有可重启的宿主，空实现） ----
  if (route === '/reload') {
    await readBody(req);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- 素材：动画 webm（/thumb/<素材根>/<名>.webm） ----
  if (route.startsWith('/thumb/')) {
    const rest = route.slice('/thumb/'.length).split('/').filter(Boolean);
    // 规则：第一段 = 素材根（条目 key，如 main），其余 = 文件名（可能含 /）
    const segs = rest.slice(1);
    const file = segs.length ? safeResolve(WEBM_ROOT, segs) : null;
    if (!file) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    streamFile(req, res, file, 'video/webm', 3600);
    return;
  }

  // ---- 素材：字体（/font/<名>.ttf） ----
  if (route.startsWith('/font/')) {
    const segs = route.slice('/font/'.length).split('/').filter(Boolean);
    const file = segs.length ? safeResolve(FONT_ROOT, segs) : null;
    if (!file) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    streamFile(req, res, file, 'font/ttf', 86400);
    return;
  }

  // ---- 素材：表情包（/pic/memes/<名>.png） ----
  if (route.startsWith('/pic/memes/')) {
    const segs = route.slice('/pic/memes/'.length).split('/').filter(Boolean);
    const file = segs.length ? safeResolve(MEME_ROOT, segs) : null;
    if (!file) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    streamFile(req, res, file, 'image/png', 86400);
    return;
  }

  // ---- 素材：其它图标（/pic/<名>） ----
  if (route.startsWith('/pic/')) {
    const segs = route.slice('/pic/'.length).split('/').filter(Boolean);
    const file = segs.length ? safeResolve(PIC_ROOT, segs) : null;
    if (!file) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    const ext = (segs[segs.length - 1].split('.').pop() || '').toLowerCase();
    const type = ext === 'png' ? 'image/png' : ext === 'svg' ? 'image/svg+xml' : 'application/octet-stream';
    streamFile(req, res, file, type, 86400);
    return;
  }

  // ---- 音效（/sound/<名>.mp3）----
  // 本版新增：上游完全没有音频能力（webm 是纯 VP9 无音轨、代码里零 audio 引用），
  // 点击音效由页面补丁 patch-sound.js 从这里取。目录在 standalone/sound（不属于上游素材）。
  if (route.startsWith('/sound/')) {
    const segs = route.slice('/sound/'.length).split('/').filter(Boolean);
    const file = segs.length ? safeResolve(SOUND_ROOT, segs) : null;
    if (!file) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    const ext = (segs[segs.length - 1].split('.').pop() || '').toLowerCase();
    const type =
      ext === 'mp3'
        ? 'audio/mpeg'
        : ext === 'wav'
          ? 'audio/wav'
          : ext === 'ogg'
            ? 'audio/ogg'
            : 'application/octet-stream';
    streamFile(req, res, file, type, 86400);
    return;
  }

  // ---- 软件外壳扩展路由（app/main.cjs 注入：POST /settings、POST /quit） ----
  // 放在内置路由之后、404 之前：既不会覆盖上游契约，又能让渲染端右键菜单驱动主进程。
  if (typeof ctx.extraRoutes === 'function') {
    let handled = false;
    try {
      handled = (await ctx.extraRoutes(route, req, res, ctx)) === true;
    } catch (e) {
      log('扩展路由异常 ' + route + '：' + String(e?.message || e));
    }
    if (handled) return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('standalone server: not found ' + pathname);
}

let logEnabled = true;
/** 日志出口：默认写 stdout；软件外壳（app/main.cjs）会注入自己的落盘函数 */
let logSink = null;
function log(msg) {
  if (!logEnabled) return;
  const line = `[dsh-pet-standalone] ${new Date().toTimeString().slice(0, 8)} ${msg}`;
  if (typeof logSink === 'function') {
    try {
      logSink(line);
      return;
    } catch {
      /* 注入的出口异常：回落到 stdout */
    }
  }
  process.stdout.write(line + '\n');
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------
/**
 * 起服务。
 * @param {{port?: number, quiet?: boolean}} options port 缺省 0 = 由系统分配空闲端口
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
export async function startServer(options = {}) {
  const port = Number.isFinite(options.port) ? Number(options.port) : 0;
  if (options.quiet) logEnabled = false;
  if (typeof options.onLog === 'function') logSink = options.onLog; // 见 app/main.cjs：日志落 app.log

  const cfg = loadConfig();
  const st = createState(cfg);
  // extraRoutes：软件外壳的扩展路由钩子（/settings、/quit）——见 app/main.cjs
  const ctx = { cfg, st, extraRoutes: typeof options.extraRoutes === 'function' ? options.extraRoutes : null };

  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
      log('请求处理异常: ' + String(e?.message || e));
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('standalone server error: ' + String(e?.message || e));
      } catch {
        /* 响应已发出 */
      }
    });
  });

  await new Promise((resolve_, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve_);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const base = `http://127.0.0.1:${actualPort}${PREFIX}`;

  // 启动即查一次余额：让渲染端首拉就有数据，点击能 0 延迟显示。
  // deferInitialBalance=true（软件外壳 app/main.cjs 使用）：改到后台进行——
  // 起服务从"等一次 HTTPS 往返（1~3 秒）"缩短到几十毫秒，确保它先于 Electron ready 完成，
  // 否则窗口 query 里的 configUrl 会定格成预置值（见 app/main.cjs 文件头的时序说明）。
  const initialBalance = () =>
    refreshBalance(st, { manual: false }).then((first) =>
      log(
        first.ok
          ? `余额初始查询成功：¥${first.data.total}（${first.data.currency}）`
          : `余额初始查询不可用：reason=${first.reason}${first.message ? ' ' + first.message : ''}`,
      ),
    );
  if (options.deferInitialBalance === true) {
    setTimeout(() => void initialBalance(), 200);
  } else {
    await initialBalance();
  }

  // 周期刷新：按 config.jsonc 的 eventsRefreshSec.balance（默认本版 300 秒）
  st.timer = setInterval(() => {
    void refreshBalance(st, { manual: false }).then((r) => {
      log(r.ok ? `余额周期刷新：¥${r.data.total}` : `余额周期刷新失败：${r.reason}`);
    });
  }, st.balanceRefreshMs);
  st.timer.unref?.();

  log(`服务已启动：${base}/config`);
  log(`余额刷新周期：每 ${Math.round(st.balanceRefreshMs / 1000)} 秒`);

  return {
    port: actualPort,
    url: base,
    state: st,
    close: () =>
      new Promise((done) => {
        if (st.timer) clearInterval(st.timer);
        server.close(() => done());
      }),
  };
}

// 直接 `node server.mjs` 运行时：固定 8231 便于调试
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.argv[2] || 8231);
  const handle_ = await startServer({ port });
  log(`（调试模式）configUrl = ${handle_.url}/config`);
}

export { PREFIX, loadConfig, queryBalance };
