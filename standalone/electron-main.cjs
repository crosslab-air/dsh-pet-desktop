/**
 * standalone/electron-main.cjs —— Electron 入口包装（**不改上游仓库一行**的关键件）
 * ============================================================================
 * 为什么要这一层：
 *   上游 runtime/electron-helper/main.js 是官方桌面 Helper 的主进程，直接可以跑；但它有两处
 *   与「脱离版」不兼容的地方，而我又承诺不动上游源码，于是用「包装 + 运行期注入」解决：
 *
 *   ① 路径问题：上游写的是 win.loadFile('index.html')（相对路径，依赖 appPath = helper 目录）。
 *      本入口在 standalone/ 下，Electron 算出来的 appPath 会变成 standalone/，相对路径必然解析失败。
 *      → 这里包装 BrowserWindow.prototype.loadFile，把 'index.html' 重写成 helper 目录的绝对路径。
 *
 *   ② 交互增强：上游左键点击只播「点击回应」，余额气泡只在右键菜单→查看余额时出现。
 *      用户要的是「点一下同时出余额气泡」。
 *      → 页面加载完成后经 webContents.executeJavaScript 注入
 *        standalone/patch-click-balance.js（在页面主世界执行，不会被 index.html 的 CSP 拦截——
 *        上游自己的冒烟自检就是靠 executeJavaScript 读页面状态的，同一条路）。
 *
 * 为什么能在 require 上游之前打上补丁：上游 main.js 里
 *   const { app, BrowserWindow, ... } = require('electron');
 * 解构出来的 BrowserWindow 与本文件拿到的是**同一个类对象**，改它的 prototype 对上游同样生效。
 *
 * 注入点选 did-finish-load：它在页面全部脚本（shared-core/constants/sprite/events/renderer）
 * 执行完之后触发，此时 PetSprite、S、balance 等全局都已就绪，且 boot() 的首次 fetch 还在路上，
 * 不会漏掉任何一次点击。
 * ============================================================================
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

const HELPER_DIR = path.resolve(__dirname, '..', 'dsh-pet', 'runtime', 'electron-helper');
const HELPER_INDEX = path.join(HELPER_DIR, 'index.html');
const HELPER_MAIN = path.join(HELPER_DIR, 'main.js');
/**
 * 运行期补丁：按顺序注入（都是"包一层"式增强，互不干扰）
 *   ① patch-click-balance.js —— 左键点击 = 点击回应动画 + 余额气泡
 *   ② patch-shell.js         —— 右键菜单追加「设置…」「退出桌宠程序」
 *   ③ patch-sound.js         —— 点击音效（上游零音频能力，音效由本补丁独立播放）
 */
const PATCH_FILES = ['patch-click-balance.js', 'patch-shell.js', 'patch-sound.js'].map((f) =>
  path.join(__dirname, f),
);
/**
 * 本地服务基址（形如 http://127.0.0.1:8231/dsh-pet-7340）。
 * 由软件外壳 app/main.cjs 写进 env：页面补丁要靠它回调 /settings 与 /quit 两条控制路由
 * （渲染端拿不到 electron 模块，页面 CSP 又本就允许 http: —— 这是零改上游下唯一干净的控制通道）。
 *
 * ⚠️ 刻意**不在本文件顶层缓存它的值**：本文件是在软件外壳起服务**之前**被 require 的
 * （见 app/main.cjs 文件头的时序说明），那一刻 env 里还没有这个变量。
 * 必须在「注入那一刻」再读 —— 否则页面拿到空串，右键「设置…」「退出桌宠程序」会静默无反应（已实测踩到）。
 */
const standaloneBaseNow = () => process.env.DSH_PET_STANDALONE_BASE || '';

for (const [label, p] of [
  ['上游 index.html', HELPER_INDEX],
  ['上游 main.js', HELPER_MAIN],
]) {
  if (!fs.existsSync(p)) {
    process.stderr.write(`[standalone] 找不到${label}：${p}\n请确认上游仓库解包在 dsh-pet/ 目录下。\n`);
    process.exit(2);
  }
}

const INJECT_PATCH = process.env.DSH_PET_STANDALONE_PATCH !== '0';

const originalLoadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function patchedLoadFile(file, options) {
  let target = file;
  const isPetPage = typeof file === 'string' && !path.isAbsolute(file) && path.basename(file) === 'index.html';
  if (isPetPage) {
    target = HELPER_INDEX;
    // 登记为「宠物窗口」：软件外壳的托盘（显示/隐藏桌宠）、退出前诊断都需要一份窗口清单
    if (!Array.isArray(globalThis.__standalonePetWindows)) globalThis.__standalonePetWindows = [];
    globalThis.__standalonePetWindows.push(this);
  }
  const ret = originalLoadFile.call(this, target, options);

  // 补丁只注入宠物页面；设置窗口走 loadURL(file://) 不会命中这里，天然隔离
  if (INJECT_PATCH && isPetPage) {
    this.webContents.on('did-finish-load', () => {
      let source;
      try {
        const parts = PATCH_FILES.map((p) => fs.readFileSync(p, 'utf8'));
        // 先注入基址与音效配置，再跑补丁（patch-shell.js 首段读 window.__standaloneBase，
        // patch-sound.js 读 window.__standaloneSound）。两者都必须在「注入这一刻」现读 env ——
        // 前者由软件外壳起服务后写入，后者由软件外壳起进程时写入、并在设置窗口改动后刷新。
        source =
          'window.__standaloneBase=' +
          JSON.stringify(standaloneBaseNow()) +
          ';\n' +
          'window.__standaloneSound=' +
          (process.env.DSH_PET_STANDALONE_SOUND || 'null') +
          ';\n' +
          parts.join('\n;\n');
      } catch (e) {
        process.stderr.write('[standalone] 读取运行期补丁失败：' + String((e && e.message) || e) + '\n');
        return;
      }
      this.webContents.executeJavaScript(source, true).catch((e) => {
        process.stderr.write('[standalone] 注入运行期补丁失败：' + String((e && e.message) || e) + '\n');
      });
    });
  }

  return ret;
};

process.stdout.write('[standalone] 已包装 loadFile；运行期补丁 ' + (INJECT_PATCH ? '启用' : '禁用') + '\n');

// 交棒给上游 Helper 主进程（此后 app.whenReady / 建窗 / IPC / 冒烟自检全部走官方实现）
require(HELPER_MAIN);
