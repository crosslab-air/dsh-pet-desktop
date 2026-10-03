/**
 * standalone/app/main.cjs —— 「DS小鲸鱼」桌面软件外壳（进程唯一入口）
 * ============================================================================
 * 这一层解决的正是"像个软件"这件事：**双击图标就开、没有控制台窗口、关设置窗口不影响桌宠、
 * 在桌宠身上右键「退出桌宠程序」才彻底关闭**。它是一套**单进程**外壳：
 *
 *   早期方案：cmd 窗口 -> node 启动器 -> 起本地服务 -> spawn electron.exe helper
 *        （两个进程 + 一个控制台窗口；关掉控制台 = 杀掉整只桌宠）
 *   本方案：electron.exe standalone/app -> 本地服务就跑在 Electron 主进程里 -> 上游 helper 同进程
 *        （一个进程、零控制台、零 node 依赖；设置窗口只是主进程开的一个普通窗口）
 *
 * ---------------------------------------------------------------------------
 * 时序约束（这是本文件最需要小心的部分，顺序错一处就白屏）
 * ---------------------------------------------------------------------------
 * 上游 runtime/electron-helper/main.js 顶层有 4 处**必须在 app ready 之前**执行的调用
 * （autoplay-policy / setName / disableHardwareAcceleration / force-device-scale-factor），
 * 否则会在 ready 之后变成无效调用（余额动画不自动播、透明窗黑边回归）。
 * 而我们又必须先起本地服务才知道端口 -> 才知道 DSH_PET_CONFIG_URL。
 *
 * 解法（两层保险，都不需要复制上游任何代码）：
 *   ① **先同步 require 上游**（所以它的 ready 前调用全部准时生效），再异步起服务；
 *      上游真正的建窗在 `app.whenReady().then(...)` 里，而我们把 `DSH_PET_CONFIG_URL`
 *      **预置**成首选端口 8231 的地址 —— 服务默认就绑 8231，因此绝大多数情况下端口与预置值
 *      完全一致，竞态不存在。
 *   ② 服务改为 `deferInitialBalance`（首查余额放到后台），使"起服务"从 1~3 秒（等一次 HTTPS）
 *      压缩到几十毫秒，远快于 Electron ready，几乎不可能落到 ready 之后。
 *   ③ 万一 8231 被别的程序占着而改用随机端口：紧接在 env 更新后检查是否已有宠物窗口建好，
 *      有则直接 reload（窗口 query 里的 configUrl 是建窗时固化的，reload 无效）—— 所以这里
 *      采取的是**更早发现、明确告知**：写日志 + 弹一次提示，让用户重启一次即可，不会静默白屏。
 *
 * ---------------------------------------------------------------------------
 * 目录约定（全部在这一层集中，便于整体搬移）
 * ---------------------------------------------------------------------------
 *   <仓库根>\standalone\app\       本目录：软件入口（main.cjs / settings.html / preload）
 *   <仓库根>\standalone\           服务与补丁（server.mjs / patch-*.js / config.jsonc / credential.json）
 *   <仓库根>\dsh-pet\              上游仓库（**零改动**）
 *   <仓库根>\electron\             Electron 运行时（首次启动由「启动桌宠.cmd」自动下载）
 *   <仓库根>\data\                 程序数据：app.log / prefs.json / runtime.json / icon.ico
 *   <仓库根>\userdata\             Chromium profile（Electron userData，与源码隔离）
 * ============================================================================
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------
const APP_DIR = __dirname;
const STANDALONE_DIR = path.resolve(APP_DIR, '..');
const ROOT = path.resolve(STANDALONE_DIR, '..');
const HELPER_DIR = path.join(ROOT, 'dsh-pet', 'runtime', 'electron-helper');
const WRAPPER_ENTRY = path.join(STANDALONE_DIR, 'electron-main.cjs');
const SERVER_ENTRY = path.join(STANDALONE_DIR, 'server.mjs');

const DATA_DIR = path.join(ROOT, 'data');
const USERDATA_DIR = path.join(ROOT, 'userdata');
const LOG_FILE = path.join(DATA_DIR, 'app.log');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const ICON_ICO = path.join(DATA_DIR, 'icon.ico');
const CRED_FILE = path.join(STANDALONE_DIR, 'credential.json');
const CONFIG_FILE = path.join(STANDALONE_DIR, 'config.jsonc');
const ICON_SRC = path.join(ROOT, 'dsh-pet', 'assets', 'logo.png');
const SETTINGS_HTML = path.join(APP_DIR, 'settings.html');
const SETTINGS_PRELOAD = path.join(APP_DIR, 'preload-settings.cjs');

const APP_TITLE = 'DS小鲸鱼';
const APP_VERSION = '1.0.0';
const AUMID = 'com.dshpet.whale';
// 桌面快捷方式名（托盘菜单里可随时创建 / 更新）。
// 刻意没有用「DS小鲸鱼.lnk」这个名字，是为了避免与本机原有的旧桌宠快捷方式重名冲突；
// 你如果只有一个桌宠，改名成任何喜欢的名字都不影响功能。
const SHORTCUT_NAME = 'dsh-pet 桌宠.lnk';
const PREFERRED_PORT = 8231; // 与预置 DSH_PET_CONFIG_URL 保持一致（见文件头①）
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* 数据目录建不出来时后续会以只读方式降级运行 */
}

// ---------------------------------------------------------------------------
// 日志：GUI 程序没有控制台，把 stdout / stderr 全部重定向到 data/app.log
// 这样"关掉窗口"不再等于"看不到任何信息"，排查时直接看文件即可。
// ---------------------------------------------------------------------------
function rotateLogIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_ROTATE_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch {
    /* 轮转失败不影响写日志 */
  }
}
rotateLogIfNeeded();

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(message) {
  try {
    fs.appendFileSync(LOG_FILE, `[${stamp()}] ${message}\n`, 'utf8');
  } catch {
    /* 磁盘满等情况：静默，绝不因为日志把程序搞崩 */
  }
}
/** 把一段可能多行的文本按行写进日志（带上游原始前缀） */
function logBlock(prefix, text) {
  const s = typeof text === 'string' ? text : String(text);
  for (const line of s.split(/\r?\n/)) {
    if (line.trim()) log(prefix + line);
  }
}

// 接管 stdout / stderr（上游 helper 与本地服务都靠它输出）
process.stdout.write = function (chunk, enc, cb) {
  logBlock('', Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  if (typeof enc === 'function') enc();
  else if (typeof cb === 'function') cb();
  return true;
};
process.stderr.write = function (chunk, enc, cb) {
  logBlock('[err] ', Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  if (typeof enc === 'function') enc();
  else if (typeof cb === 'function') cb();
  return true;
};

process.on('uncaughtException', (e) => log('[fatal] uncaughtException: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => log('[fatal] unhandledRejection: ' + (e && e.stack ? e.stack : e)));

log('================ 启动 ' + APP_TITLE + ' v' + APP_VERSION + ' ================');

// ---------------------------------------------------------------------------
// 纯 Node 模式自救（**必须早于一切 Electron API 调用**）
// ---------------------------------------------------------------------------
// 若本进程被以 ELECTRON_RUN_AS_NODE 拉起（某些宿主程序 / 终端 / 调试器会把该变量透传给子进程），
// Electron 的内置模块不会注册：require('electron') 只返回 exe 路径字符串，app/BrowserWindow 全部不可用。
// 该变量的判定发生在**进程启动那一刻**，运行期再 delete 无效（上游 main.js 文件头也写明了这一点：
// "运行期再删无效，设成空串会让 Electron 直接 abort"）。所以唯一解法是：
// 立刻用"净化后的环境"把自己重新拉起一次，本次进程退出 —— 用户体感上无感。
{
  let probe = null;
  try {
    probe = require('electron');
  } catch {
    probe = null;
  }
  if (typeof probe === 'string') {
    const { spawn } = require('node:child_process');
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      spawn(process.execPath, [APP_DIR], { env, detached: true, stdio: 'ignore', windowsHide: false }).unref();
      log('[warn] 检测到 ELECTRON_RUN_AS_NODE=' + JSON.stringify(process.env.ELECTRON_RUN_AS_NODE) + '：已用净化环境重新拉起。');
    } catch (e) {
      log('[fatal] 自救重启失败：' + ((e && e.message) || e));
    }
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Electron 基础设置（必须早于任何 getPath('userData')）
// ---------------------------------------------------------------------------
const electron = require('electron');
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain, dialog } = electron;

app.setName(APP_TITLE);
try {
  app.setPath('userData', USERDATA_DIR);
} catch (e) {
  log('userData 目录设置失败：' + (e && e.message));
}
try {
  app.setAppUserModelId(AUMID);
} catch {
  /* 非 Windows 平台无此 API */
}

// 单实例：双击两次只留一只。第二次启动把已有实例的设置窗口唤到前面。
if (!app.requestSingleInstanceLock()) {
  log('已有实例在运行，本次启动直接退出。');
  app.exit(0);
  return;
}
app.on('second-instance', () => {
  log('检测到第二次启动：唤起设置窗口。');
  openSettings();
});

// ---------------------------------------------------------------------------
// 偏好（data/prefs.json）
// ---------------------------------------------------------------------------
// sound / vol / soundSet 三项对齐旧桌宠 DS 小鲸鱼的 widget 配置（sound=true / vol=0.68 / soundSet="duck"）
const PREFS_DEFAULT = {
  scale: 1,
  autostart: false,
  shortcutAtStart: true,
  sound: true,
  vol: 0.68,
  soundSet: 'duck',
};
function loadPrefs() {
  try {
    return Object.assign({}, PREFS_DEFAULT, JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')));
  } catch {
    return Object.assign({}, PREFS_DEFAULT);
  }
}
function savePrefs(p) {
  try {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2), 'utf8');
  } catch (e) {
    log('prefs 写入失败：' + (e && e.message));
  }
}
const prefs = loadPrefs();

// ---------------------------------------------------------------------------
// 音效配置（点击音效，由 standalone/patch-sound.js 消费）
//   · soundConfig()  归一化成页面要的形状 { on, vol, set }
//   · pushSoundConfig() 写进 env（供页面首次注入读取），并**实时下发**到已打开的宠物窗口 ——
//     所以在设置窗口改音量/音效组/开关是立即生效的，不需要重启桌宠。
// ---------------------------------------------------------------------------
const SOUND_SETS = ['duck', 'dingdong'];
function soundConfig() {
  const v = Number(prefs.vol);
  return {
    on: prefs.sound !== false,
    vol: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.68,
    set: SOUND_SETS.includes(prefs.soundSet) ? prefs.soundSet : 'duck',
  };
}
function pushSoundConfig() {
  const json = JSON.stringify(soundConfig());
  process.env.DSH_PET_STANDALONE_SOUND = json;
  for (const w of petWindows()) {
    try {
      w.webContents.executeJavaScript('window.__standaloneSound=' + json + ';', true).catch(() => {});
    } catch (e) {
      log('音效配置下发失败：' + ((e && e.message) || e));
    }
  }
}

// ---------------------------------------------------------------------------
// 同步读配置（必须在 require 上游之前完成：DSH_PET_PETS 要用它推导宠物窗口数）
// 规则与上游保持一致（stripJsonc + display=desktop|both 才进桌面）
// ---------------------------------------------------------------------------
const stripJsonc = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

function readConfigSync() {
  try {
    return JSON.parse(stripJsonc(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (e) {
    log('config.jsonc 读取/解析失败：' + (e && e.message));
    return null;
  }
}

const config = readConfigSync();
const desktopPets = (() => {
  const list = Array.isArray(config && config.pets) ? config.pets : [];
  const visible = (d) => d === 'desktop' || d === 'both';
  const pets = list
    .filter((p) => visible(p && p.display === undefined ? 'both' : p.display))
    .map((p, i) => ({ id: String((p && p.id) || `pet-${i}`), size: Number(p && p.size) > 0 ? Number(p.size) : 462 }));
  return pets.length ? pets : [{ id: 'main', size: 462 }];
})();

// ---------------------------------------------------------------------------
// 预置环境（见文件头时序①）：此刻不 await 任何东西，保证上游 ready 前的调用准时
// 另有 3 个变量属于"故意不注入 / 主动清掉"：DSH_PET_HOST_PID（让我们不自退）、
// DSH_PET_BRIDGE（不走宿主桥接、直接走本地 HTTP），以及清空 ELECTRON_RUN_AS_NODE
// （留着它 Electron 会退化成纯 Node 模式，所有 Electron API 不可用）。
// ---------------------------------------------------------------------------
process.env.DSH_PET_CONFIG_URL = `http://127.0.0.1:${PREFERRED_PORT}/dsh-pet-7340/config`;
process.env.DSH_PET_SCALE = String(Number(prefs.scale) > 0 ? Number(prefs.scale) : 1);
process.env.DSH_PET_PETS = JSON.stringify(desktopPets);
// 音效配置：包装层注入页面时读到，成为 window.__standaloneSound（patch-sound.js 消费）
process.env.DSH_PET_STANDALONE_SOUND = JSON.stringify(soundConfig());
delete process.env.DSH_PET_HOST_PID;
delete process.env.DSH_PET_BRIDGE;
delete process.env.ELECTRON_RUN_AS_NODE;

// ---------------------------------------------------------------------------
// 交棒给包装层 -> 上游 Helper 主进程（此后窗口创建全走官方实现）
// ---------------------------------------------------------------------------
try {
  require(WRAPPER_ENTRY);
  log('已加载包装层与上游 Helper（helper=' + HELPER_DIR + '）');
} catch (e) {
  log('[fatal] 加载上游 Helper 失败：' + (e && e.stack ? e.stack : e));
  try {
    dialog.showErrorBox(APP_TITLE + ' 启动失败', '无法加载上游桌面 Helper：\n' + String((e && e.message) || e));
  } catch {
    /* 无 GUI 时忽略 */
  }
  app.exit(1);
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------
let serverMod = null;
let serverHandle = null;
let tray = null;
let settingsWin = null;
let quitting = false;

// ---------------------------------------------------------------------------
// 本地服务：起服务 + 补两条"软件外壳"控制路由（渲染端右键菜单用）
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

/**
 * 上游内置路由之外的扩展路由（server.mjs 的 extraRoutes 钩子）。
 * 只服务桌宠右键菜单里的两项：设置… / 退出桌宠程序。
 * 走裸 HTTP 而不是 preload：页面 CSP 本就允许 http:（它要靠它取 /state 与 /thumb），
 * 且渲染端拿不到 electron 模块 —— 这是"零改上游"下唯一干净的控制通道。
 */
async function handleExtraRoute(route, req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '600',
    });
    res.end();
    return true;
  }
  if (req.method !== 'POST') return false;

  if (route === '/quit') {
    sendJson(res, 200, { ok: true });
    log('收到桌宠右键「退出桌宠程序」请求。');
    setImmediate(() => void quitApp('桌宠右键菜单'));
    return true;
  }
  if (route === '/settings') {
    openSettings();
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (route === '/ping') {
    // 页面补丁启动时发来的自检：证明「渲染端 → 本地服务」通道可用（右键两项依赖它）
    log('控制通道自检通过：页面已连通（/ping）');
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (route === '/selftest') {
    // 自检：打开设置窗口 -> 主动关闭它 -> 断言桌宠仍在。
    // 对应需求里最容易被怀疑的一条：「关掉配置页面，桌宠也还在」。
    log('设置窗口自检开始：打开 -> 关闭 -> 检查桌宠是否仍在。');
    openSettings();
    sendJson(res, 200, { ok: true });
    setTimeout(() => {
      try {
        if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
      } catch (e) {
        log('自检：关闭设置窗口异常 ' + ((e && e.message) || e));
      }
      setTimeout(async () => {
        const petsAlive = petWindows().some((w) => !w.isDestroyed());
        let stateOk = false;
        try {
          const r = await fetch((process.env.DSH_PET_STANDALONE_BASE || '') + '/state');
          stateOk = r.ok;
        } catch {
          stateOk = false;
        }
        log('自检结果：设置窗口关闭后 —— 桌宠窗口存活=' + petsAlive + '，本地服务 /state 可用=' + stateOk);
      }, 1500);
    }, 2000);
    return true;
  }
  return false;
}

async function startLocalServer() {
  serverMod = await import(pathToFileURL(SERVER_ENTRY).href);
  const common = {
    quiet: true,
    deferInitialBalance: true, // 见文件头时序②：首查余额转后台，让起服务变成几十毫秒
    onLog: (m) => log('[server] ' + m),
    extraRoutes: handleExtraRoute,
  };
  try {
    const h = await serverMod.startServer(Object.assign({ port: PREFERRED_PORT }, common));
    log('本地服务已启动（首选端口 ' + PREFERRED_PORT + '）：' + h.url);
    return h;
  } catch (e) {
    log('首选端口 ' + PREFERRED_PORT + ' 不可用（' + String((e && e.message) || e) + '），改用系统分配端口。');
    const h = await serverMod.startServer(Object.assign({ port: 0 }, common));
    log('本地服务已启动（随机端口）：' + h.url);
    return h;
  }
}

(async () => {
  try {
    serverHandle = await startLocalServer();
  } catch (e) {
    log('[fatal] 本地服务启动失败：' + (e && e.stack ? e.stack : e));
    try {
      dialog.showErrorBox(APP_TITLE + ' 启动失败', '本地服务无法启动，桌宠不会出现：\n' + String((e && e.message) || e));
    } catch {
      /* 忽略 */
    }
    return;
  }

  // 把真实地址同步进 env 与页面补丁（若与预置一致则本就无需改动）
  const changed = process.env.DSH_PET_CONFIG_URL !== serverHandle.url + '/config';
  process.env.DSH_PET_CONFIG_URL = serverHandle.url + '/config';
  process.env.DSH_PET_STANDALONE_BASE = serverHandle.url;

  const windows = Array.isArray(globalThis.__standalonePetWindows) ? globalThis.__standalonePetWindows : [];
  if (changed && windows.length) {
    // 窗口 query 里的 configUrl 是建窗时固化的，reload 也改不回来 —— 明确告知而不是静默白屏
    log('[warn] 端口与预置值不一致且宠物窗口已创建，需重启一次才能让页面连上服务。');
    try {
      dialog.showMessageBox({
        type: 'warning',
        title: APP_TITLE,
        message: '请重启一次桌宠',
        detail: `首选端口 ${PREFERRED_PORT} 被占用，已改用 ${serverHandle.port}。\n请右键桌宠 ->「退出桌宠程序」后重新启动。`,
        buttons: ['知道了'],
      });
    } catch {
      /* 忽略 */
    }
  }

  writeRuntimeFile();
  log('就绪：' + APP_TITLE + ' 已在运行（进程 pid=' + process.pid + '）');
})();

function writeRuntimeFile() {
  try {
    fs.writeFileSync(
      RUNTIME_FILE,
      JSON.stringify(
        {
          app: APP_TITLE,
          version: APP_VERSION,
          pid: process.pid,
          root: ROOT,
          base: process.env.DSH_PET_STANDALONE_BASE || '',
          configUrl: process.env.DSH_PET_CONFIG_URL || '',
          logFile: LOG_FILE,
          pets: desktopPets,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (e) {
    log('runtime.json 写入失败：' + (e && e.message));
  }
}

// ---------------------------------------------------------------------------
// 图标：由 assets/logo.png（官方 256×256 logo）生成多尺寸 .ico
// 用途：桌面快捷方式图标 / 设置窗口图标 / 托盘图标
// ---------------------------------------------------------------------------
function buildIco() {
  try {
    if (!fs.existsSync(ICON_SRC)) return false;
    const base = nativeImage.createFromPath(ICON_SRC);
    if (base.isEmpty()) return false;
    const sizes = [256, 128, 64, 48, 32, 16];
    const images = [];
    for (const s of sizes) {
      const img = s === 256 ? base : base.resize({ width: s, height: s, quality: 'best' });
      const buf = img && img.toPNG();
      if (buf && buf.length) images.push({ size: s, buf });
    }
    if (!images.length) return false;
    // ICO 容器：ICONDIR(6) + ICONDIRENTRY×n(16) + 各帧 PNG 数据（Vista+ 支持内嵌 PNG）
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    const dir = Buffer.alloc(16 * images.length);
    let offset = 6 + 16 * images.length;
    images.forEach((it, i) => {
      const o = i * 16;
      dir.writeUInt8(it.size >= 256 ? 0 : it.size, o + 0);
      dir.writeUInt8(it.size >= 256 ? 0 : it.size, o + 1);
      dir.writeUInt8(0, o + 2);
      dir.writeUInt8(0, o + 3);
      dir.writeUInt16LE(1, o + 4);
      dir.writeUInt16LE(32, o + 6);
      dir.writeUInt32LE(it.buf.length, o + 8);
      dir.writeUInt32LE(offset, o + 12);
      offset += it.buf.length;
    });
    fs.writeFileSync(ICON_ICO, Buffer.concat([header, dir].concat(images.map((i) => i.buf))));
    log('图标已生成：' + ICON_ICO + '（' + images.map((i) => i.size).join('/') + '）');
    return true;
  } catch (e) {
    log('图标生成失败（将回落到默认图标）：' + (e && e.message));
    return false;
  }
}

function appIconImage() {
  if (fs.existsSync(ICON_ICO)) {
    const img = nativeImage.createFromPath(ICON_ICO);
    if (!img.isEmpty()) return img;
  }
  if (fs.existsSync(ICON_SRC)) return nativeImage.createFromPath(ICON_SRC);
  return nativeImage.createEmpty();
}

// ---------------------------------------------------------------------------
// 桌面快捷方式（"像个软件"的关键一步）
// ---------------------------------------------------------------------------
function shortcutPath() {
  let desktop = '';
  try {
    desktop = app.getPath('desktop');
  } catch {
    desktop = '';
  }
  return desktop ? path.join(desktop, SHORTCUT_NAME) : '';
}

function createShortcut() {
  const lnk = shortcutPath();
  if (!lnk) return { ok: false, message: '取不到桌面目录' };
  try {
    const target = process.execPath; // electron.exe
    const icon = fs.existsSync(ICON_ICO) ? ICON_ICO : target;
    // 已存在就 update（用户挪过目录后能自愈），不存在才 create —— 绝不用 replace 去覆盖别人的快捷方式
    const operation = fs.existsSync(lnk) ? 'update' : 'create';
    const ok = shell.writeShortcutLink(lnk, operation, {
      target,
      args: `"${APP_DIR}"`,
      cwd: ROOT,
      icon,
      iconIndex: 0,
      description: APP_TITLE + ' — 桌面桌宠（dsh-pet 脱离版）',
      appUserModelId: AUMID,
    });
    log((ok ? '桌面快捷方式已' : '桌面快捷方式创建失败：') + lnk);
    return ok ? { ok: true, path: lnk } : { ok: false, message: '写入快捷方式失败', path: lnk };
  } catch (e) {
    log('创建快捷方式异常：' + (e && e.message));
    return { ok: false, message: String((e && e.message) || e) };
  }
}

function shortcutInfo() {
  const lnk = shortcutPath();
  if (!lnk) return { path: '', exists: false };
  return { path: lnk, exists: fs.existsSync(lnk) };
}

// ---------------------------------------------------------------------------
// 托盘：即便桌宠被甩到屏幕外/被遮挡，也能从托盘把它找回来或退出
// ---------------------------------------------------------------------------
function petWindows() {
  return (Array.isArray(globalThis.__standalonePetWindows) ? globalThis.__standalonePetWindows : []).filter(
    (w) => w && !w.isDestroyed(),
  );
}

function setPetsVisible(visible) {
  for (const w of petWindows()) {
    try {
      if (visible) w.show();
      else w.hide();
    } catch {
      /* 单个窗口异常不影响其它 */
    }
  }
}

function setupTray() {
  try {
    const icon = appIconImage().resize({ width: 16, height: 16, quality: 'best' });
    tray = new Tray(icon.isEmpty() ? appIconImage() : icon);
    tray.setToolTip(APP_TITLE + '（右键可退出）');
    refreshTrayMenu();
    tray.on('double-click', () => openSettings());
  } catch (e) {
    log('托盘创建失败（不影响桌宠本体）：' + (e && e.message));
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const anyVisible = petWindows().some((w) => w.isVisible());
  const menu = Menu.buildFromTemplate([
    { label: anyVisible ? '隐藏桌宠' : '显示桌宠', click: () => setPetsVisible(!anyVisible) },
    { type: 'separator' },
    { label: '设置…', click: () => openSettings() },
    { label: '立即刷新余额', click: () => void refreshBalance() },
    { type: 'separator' },
    { label: '创建桌面快捷方式', click: () => wrapResult(createShortcut(), '快捷方式') },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: !!prefs.autostart,
      click: (item) => void applyAutostart(!!item.checked),
    },
    { type: 'separator' },
    { label: '打开数据目录', click: () => openExternal(DATA_DIR) },
    { label: '查看日志', click: () => openExternal(LOG_FILE) },
    { type: 'separator' },
    { label: '退出 ' + APP_TITLE, click: () => void quitApp('托盘菜单') },
  ]);
  tray.setContextMenu(menu);
}

function wrapResult(r, label) {
  if (r && r.ok) return;
  log(label + '操作未成功：' + ((r && r.message) || '未知原因'));
}

function openExternal(p) {
  try {
    if (fs.existsSync(p)) void shell.openPath(p);
    else void shell.openPath(path.dirname(p));
  } catch (e) {
    log('打开路径失败 ' + p + '：' + (e && e.message));
  }
}

// ---------------------------------------------------------------------------
// 设置窗口：**独立的普通窗口**，关掉它桌宠照常运行（这正是用户要的"配置页面"）
// ---------------------------------------------------------------------------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  try {
    settingsWin = new BrowserWindow({
      width: 760,
      height: 700,
      minWidth: 640,
      minHeight: 520,
      title: APP_TITLE + ' · 设置',
      icon: fs.existsSync(ICON_ICO) ? ICON_ICO : ICON_SRC,
      backgroundColor: '#f4f6fb',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: SETTINGS_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    // 用 loadURL(file://) 而不是 loadFile：包装层只对 index.html 做重定向与补丁注入，
    // 走 loadURL 可以完全避开那条路径（设置页不需要桌宠补丁）。
    void settingsWin.loadURL(pathToFileURL(SETTINGS_HTML).href);
    settingsWin.once('ready-to-show', () => settingsWin.show());
    // 可观测性：确认设置页加载成功、preload 桥可用（出问题时看日志即可定位，不必猜）
    settingsWin.webContents.on('did-finish-load', () => {
      settingsWin.webContents
        .executeJavaScript('typeof window.dsh === "object" && typeof window.dsh.get === "function"')
        .then((ok) => log('设置窗口已打开（preload 桥：' + (ok ? '正常' : '缺失') + '；关闭它不影响桌宠）'))
        .catch((e) => log('设置窗口 preload 探测失败：' + ((e && e.message) || e)));
    });
    settingsWin.on('closed', () => {
      settingsWin = null;
      log('设置窗口已关闭（桌宠继续运行）。');
    });
  } catch (e) {
    log('设置窗口创建失败：' + (e && e.message));
  }
}

// ---------------------------------------------------------------------------
// 余额 / 峰谷（与 dsh-pet 原生同一口径：src/shared/balance.ts 的 deepseekPricingTier）
// 注意：上游口径只判「工作日时段 + 周六周日」，**不认法定节假日与调休补班**。
//      与用户现有那只桌宠（认节假日日历）存在差异，属已知待办，不在本版范围内。
// ---------------------------------------------------------------------------
function pricingTier(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return 'idle';
  const h = now.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18) ? 'peak' : 'idle';
}

function nextTierSwitch(now = new Date()) {
  const current = pricingTier(now);
  const probe = new Date(now.getTime());
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i += 1) {
    const t = pricingTier(probe);
    if (t !== current) {
      return { tier: t, at: probe.toISOString(), sec: Math.max(0, Math.round((probe.getTime() - now.getTime()) / 1000)) };
    }
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return null;
}

function balanceSnapshot() {
  const st = serverHandle && serverHandle.state;
  const data = st ? st.balanceData : null;
  if (!data) return { known: false };
  if (data.ok) {
    return {
      known: true,
      ok: true,
      currency: data.data.currency,
      total: data.data.total,
      granted: data.data.granted,
      toppedUp: data.data.toppedUp,
      counter: st.balanceCounter,
      tier: pricingTier(),
      next: nextTierSwitch(),
    };
  }
  return { known: true, ok: false, reason: data.reason || '', message: data.message || '', counter: st.balanceCounter };
}

async function refreshBalance() {
  try {
    const r = await serverMod.queryBalance();
    const st = serverHandle && serverHandle.state;
    if (st) {
      st.balanceData = Object.assign({}, r, { manual: true });
      st.balanceCounter += 1;
    }
    return r;
  } catch (e) {
    log('余额刷新异常：' + (e && e.message));
    return { ok: false, reason: 'fetch-error', message: String((e && e.message) || e) };
  }
}

function readApiKey() {
  const fromEnv = String(process.env.DSH_PET_DEEPSEEK_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return String((JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) || {}).api_key || '').trim();
  } catch {
    return '';
  }
}

function writeApiKey(key) {
  let obj = {};
  try {
    obj = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) || {};
  } catch {
    obj = {};
  }
  if (key) obj.api_key = key;
  else delete obj.api_key;
  if (obj.provider === undefined) obj.provider = 'deepseek';
  fs.writeFileSync(CRED_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// 开机自启
// ---------------------------------------------------------------------------
async function applyAutostart(enabled) {
  prefs.autostart = !!enabled;
  savePrefs(prefs);
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: [APP_DIR],
    });
    log('开机自启已' + (enabled ? '开启' : '关闭'));
  } catch (e) {
    log('设置开机自启失败：' + (e && e.message));
  }
  refreshTrayMenu();
  return { ok: true, autostart: prefs.autostart };
}

function autostartEnabled() {
  try {
    return !!app.getLoginItemSettings({ path: process.execPath, args: [APP_DIR] }).openAtLogin;
  } catch {
    return !!prefs.autostart;
  }
}

// ---------------------------------------------------------------------------
// 退出 / 重启
// ---------------------------------------------------------------------------
async function quitApp(reason) {
  if (quitting) return;
  quitting = true;
  log('正在退出（来源：' + reason + '）…');
  try {
    if (serverHandle && typeof serverHandle.close === 'function') await serverHandle.close();
  } catch (e) {
    log('关闭本地服务异常：' + (e && e.message));
  }
  try {
    fs.rmSync(RUNTIME_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
  try {
    if (tray) tray.destroy();
  } catch {
    /* 忽略 */
  }
  log('已退出 ' + APP_TITLE);
  app.exit(0);
}

function restartApp() {
  log('重启中…');
  try {
    app.relaunch({ execPath: process.execPath, args: [APP_DIR] });
  } catch (e) {
    log('relaunch 失败：' + (e && e.message));
  }
  void quitApp('重启');
}

// ---------------------------------------------------------------------------
// 设置窗口的 IPC
// ---------------------------------------------------------------------------
function tailLines(file, n) {
  try {
    const buf = fs.readFileSync(file, 'utf8');
    return buf.split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '';
  }
}

function buildOverview() {
  const key = readApiKey();
  return {
    app: {
      name: APP_TITLE,
      version: APP_VERSION,
      root: ROOT,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      electron: process.versions.electron,
      node: process.versions.node,
    },
    server: {
      base: (serverHandle && serverHandle.url) || '',
      port: (serverHandle && serverHandle.port) || 0,
      ready: !!serverHandle,
    },
    key: { has: !!key, tail: key ? key.slice(-4) : '' },
    balance: balanceSnapshot(),
    prefs: {
      scale: Number(prefs.scale) || 1,
      autostart: autostartEnabled(),
      sound: soundConfig().on,
      vol: soundConfig().vol,
      soundSet: soundConfig().set,
      soundSets: SOUND_SETS,
    },
    pets: desktopPets,
    shortcut: shortcutInfo(),
    files: { dataDir: DATA_DIR, log: LOG_FILE, credential: CRED_FILE, config: CONFIG_FILE },
    logTail: tailLines(LOG_FILE, 60),
  };
}

ipcMain.handle('dsh:get', () => buildOverview());

ipcMain.handle('dsh:setKey', async (_e, key) => {
  const k = String(key || '').trim();
  if (!k) {
    writeApiKey('');
    delete process.env.DSH_PET_DEEPSEEK_KEY;
    log('API Key 已清空。');
    return { ok: true, cleared: true, message: '已清空密钥' };
  }
  try {
    writeApiKey(k);
    process.env.DSH_PET_DEEPSEEK_KEY = k; // server 的 readApiKey 优先读 env，设了即刻生效
  } catch (e) {
    return { ok: false, message: '写入 credential.json 失败：' + String((e && e.message) || e) };
  }
  const r = await serverMod.queryBalance();
  if (r && r.ok) {
    log('API Key 已保存并通过验证（余额 ¥' + r.data.total + '）。');
    await refreshBalance();
    return { ok: true, message: '验证通过，当前余额 ¥' + r.data.total + ' ' + r.data.currency };
  }
  log('API Key 已保存，但验证未通过：' + ((r && r.reason) || '') + ' ' + ((r && r.message) || ''));
  return {
    ok: false,
    saved: true,
    message: '密钥已保存，但验证未通过：' + (((r && r.reason) || '') + ' ' + ((r && r.message) || '')).trim(),
  };
});

ipcMain.handle('dsh:refresh', async () => {
  const r = await refreshBalance();
  return {
    ok: !!(r && r.ok),
    message: r && r.ok ? '已刷新：¥' + r.data.total : '刷新失败：' + (((r && r.reason) || '') + ' ' + ((r && r.message) || '')).trim(),
    balance: balanceSnapshot(),
  };
});

ipcMain.handle('dsh:setScale', async (_e, scale) => {
  const s = Math.min(1.6, Math.max(0.6, Number(scale) || 1));
  prefs.scale = s;
  savePrefs(prefs);
  log('界面缩放已设为 ' + s + '（重启后生效）');
  return { ok: true, scale: s, needRestart: true };
});

ipcMain.handle('dsh:setAutostart', (_e, enabled) => applyAutostart(enabled));

// ---- 音效：三项都立即生效（pushSoundConfig 会下发到已打开的宠物窗口） ----
ipcMain.handle('dsh:setSound', (_e, enabled) => {
  prefs.sound = !!enabled;
  savePrefs(prefs);
  pushSoundConfig();
  log('点击音效已' + (prefs.sound ? '开启' : '关闭') + '。');
  return { ok: true, sound: prefs.sound };
});

ipcMain.handle('dsh:setVolume', (_e, vol) => {
  const v = Math.min(1, Math.max(0, Number(vol)));
  prefs.vol = Number.isFinite(v) ? v : 0.68;
  savePrefs(prefs);
  pushSoundConfig();
  return { ok: true, vol: prefs.vol };
});

ipcMain.handle('dsh:setSoundSet', (_e, set) => {
  const s = SOUND_SETS.includes(String(set)) ? String(set) : 'duck';
  prefs.soundSet = s;
  savePrefs(prefs);
  pushSoundConfig();
  log('音效组已切换为 ' + s + '。');
  return { ok: true, soundSet: s };
});

ipcMain.handle('dsh:createShortcut', () => {
  const r = createShortcut();
  refreshTrayMenu();
  return r;
});

ipcMain.handle('dsh:openPath', (_e, which) => {
  const map = {
    data: DATA_DIR,
    log: LOG_FILE,
    credential: CRED_FILE,
    config: CONFIG_FILE,
    root: ROOT,
    standalone: STANDALONE_DIR,
  };
  const target = map[String(which)] || DATA_DIR;
  openExternal(target);
  return { ok: true, path: target };
});

ipcMain.handle('dsh:restart', () => {
  setImmediate(() => restartApp());
  return { ok: true };
});

ipcMain.handle('dsh:quit', () => {
  setImmediate(() => void quitApp('设置窗口'));
  return { ok: true };
});

// 托盘/设置窗口需要感知窗口显隐，菜单文案才准
app.on('browser-window-created', () => setTimeout(refreshTrayMenu, 500));

// ---------------------------------------------------------------------------
// ready 之后：生成图标、建托盘、按需创建快捷方式
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  buildIco();

  if (process.platform === 'win32') {
    setupTray();
    // 让开机自启的注册项与偏好一致（换了安装路径后也能自愈）
    try {
      if (prefs.autostart) void applyAutostart(true);
    } catch {
      /* 忽略 */
    }
    if (prefs.shortcutAtStart && !shortcutInfo().exists) {
      setTimeout(() => {
        const r = createShortcut();
        if (r.ok) log('首次启动已自动创建桌面快捷方式：' + r.path);
      }, 2500);
    }
  }
  log('ready：托盘与图标就绪。');
});

// 退出前收尾（无论是托盘退出、右键退出还是被系统关闭）
app.on('will-quit', () => {
  try {
    if (serverHandle && typeof serverHandle.close === 'function') void serverHandle.close();
  } catch {
    /* 忽略 */
  }
});
