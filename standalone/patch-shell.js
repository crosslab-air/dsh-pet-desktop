/**
 * standalone/patch-shell.js —— 运行期补丁②：把「软件外壳」入口挂进桌宠右键菜单
 * ============================================================================
 * 目标（用户诉求）：**像软件一样**——右键宠物身上有「设置」和「退出桌宠程序」，
 * 点「退出桌宠程序」彻底关闭整只程序（而不是留下悬浮窗或需要去关控制台）。
 *
 * 本补丁共做三件事：
 *   ① 追加「设置…」          → POST /settings
 *   ② 追加「退出桌宠程序」    → POST /quit
 *   ③ 修掉上游首项「打开网站」→ 改名 + 改指 DeepSeek 用量页（见 OPEN_SITE_URL）
 *
 * 关于第 ③ 件（为什么必须修）：
 *   上游把「打开网站」指向 `ORIGIN`，而 `constants.js:121` 定义
 *     const ORIGIN = new URL(CONFIG.configUrl).origin;
 *   在原环境里 ORIGIN = **DSH 宿主的 web 服务**，那是有真实网页的。
 *   剥离宿主后，ORIGIN 变成了我们复刻的本地 **JSON 接口服务**（http://127.0.0.1:<port>）——
 *   它只提供 /config、/state、/thumb/*、/sound/* 这类接口，**没有首页**：
 *   server.mjs 的路由表里 `/` 不匹配任何分支，落到最后的兜底
 *     res.writeHead(404, ...); res.end('standalone server: not found ' + pathname);
 *   ⇒ 浏览器打开就是一张近乎空白的页（用户实测反馈"打开了网页是空的"）。
 *   处理办法是**就地改名 + 换 URL**，不改上游一行。
 *
 * 为什么这样做能"不改上游一行"：
 *   上游右键菜单统一走共享组件 `S.mountContextMenu({ tree, onAction, ... })`
 *   （调用点 sprite.js:1042，实现在 shared-core.js:637）。它在 **window.PetShared**
 *   上是普通可写属性，且渲染端每次都是「属性查找式」调用（`S.mountContextMenu(...)`），
 *   所以在这里包一层即可往菜单树里追加两项、改一项、并截获它们的动作。
 *   关键：shared-core 是在**函数体内**解构 `const { tree, x, y, onAction } = opts`，
 *   即调用时才读 ⇒ 对 opts.tree 原地改/推、对 opts.onAction 换引用都能生效。
 *
 * 控制通道：渲染端 -> 本地服务（同在主进程）裸 HTTP。
 *   页面 CSP 是 `default-src 'self' http: https: data: blob:`，connect-src 回落到 default-src，
 *   本来就要 fetch 本服务取 /state、/thumb，所以这条通道天然可用，无需 preload 改动。
 *   基址由包装层以 window.__standaloneBase 注入（= http://127.0.0.1:<port>/dsh-pet-7340）。
 *   第 ③ 件走的是上游**既有**的桥 `window.petBridge.openDshSite(url)`（主进程 shell.openExternal
 *   → 系统默认浏览器），只是换了个 URL 入参，**不需要新通道、也不需要改 preload**。
 *
 * 容错：任一步失败只打日志，菜单照常弹出，最差退化成"没有这两项 / 第③项仍指空白页"。
 * ============================================================================
 */
(function () {
  var TAG = '[standalone] ';
  if (window.__dshPetStandaloneShell) return;
  window.__dshPetStandaloneShell = true;

  /** ③「打开 DeepSeek 用量页」的目标地址。
   *  上游原动作把 ORIGIN 交给系统浏览器，而独立版 ORIGIN = 本地 JSON 接口服务（无首页）。
   *  改指 DeepSeek 开放平台用量页 —— 与本桌宠"看余额"的用途一致，且是真实存在的网页。
   *  **要换目标就改这一行**（必须是 http:// 或 https://，主进程会做这个校验）。
   *  注：项目主页 github.com 在本机被代理拦截（CONNECT 502），不适合作为目标。 */
  var OPEN_SITE_URL = 'https://platform.deepseek.com/usage';
  /** ③ 配套的菜单文案：改指之后显示原文「打开网站」会误导，改名与之对齐 */
  var OPEN_SITE_LABEL = '打开 DeepSeek 用量页';

  var Shared = window.PetShared;
  var BASE = window.__standaloneBase || '';
  // 双保险：万一基址没被注入（启动时序异常等），就从页面自己的 CONFIG.configUrl 反推
  // （CONFIG 是 constants.js 的顶层 const，同页面脚本可直接引用；末尾去掉 '/config' 即基址）
  if (!BASE) {
    try {
      if (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.configUrl) {
        BASE = String(CONFIG.configUrl).replace(/\/config$/, '');
      }
    } catch (e) {
      /* 保持空串：call() 会安全地什么都不做，最差退化成"菜单里多两项无反应的项" */
    }
  }
  if (!Shared || typeof Shared.mountContextMenu !== 'function') {
    console.warn(TAG + '补丁未生效：PetShared.mountContextMenu 未就绪');
    return;
  }

  /** 向本地服务发一个"动作"请求；失败只记日志（例如程序正在退出） */
  function call(path) {
    if (!BASE) return;
    try {
      fetch(BASE + path, { method: 'POST' }).catch(function () {});
    } catch (e) {
      console.warn(TAG + '控制请求失败 ' + path + ': ' + ((e && e.message) || e));
    }
  }

  var ACTIONS = {
    'standalone-settings': function () {
      call('/settings');
    },
    'standalone-quit': function () {
      call('/quit');
    },
  };

  var origMount = Shared.mountContextMenu;
  Shared.mountContextMenu = function patchedMountContextMenu(opts) {
    try {
      if (opts && Array.isArray(opts.tree)) {
        // ③ 上游首项「打开网站」在独立版里指向不存在的页面 ⇒ 就地改名，让它名副其实
        for (var i = 0; i < opts.tree.length; i++) {
          var node = opts.tree[i];
          if (node && node.action === 'open-site') {
            node.label = OPEN_SITE_LABEL;
            break;
          }
        }

        // ①② 追加到末尾：先"宠物互动"后"程序维护"，与上游把「重载配置」放最后同一取舍
        opts.tree.push({ label: '设置…', action: 'standalone-settings' });
        opts.tree.push({ label: '退出桌宠程序', action: 'standalone-quit' });

        var origOnAction = opts.onAction;
        opts.onAction = function patchedOnAction(leaf) {
          var fn = leaf && ACTIONS[leaf.action];
          if (fn) {
            // 让上游先关菜单（onMenuAction 里第一步就是 closeMenu），保持交互一致
            try {
              if (typeof origOnAction === 'function') origOnAction.call(this, leaf);
            } catch (e) {
              /* 忽略：上游动作处理器对本类项无副作用 */
            }
            fn();
            return;
          }

          // ③ 截获「打开网站」：上游 onMenuAction 对 open-site 会执行
          //    `petBridge.openDshSite(ORIGIN)` —— 独立版那是空白页，必须拦住。
          //    手法：先用一个**空叶子**调上游，让它的第一步 closeMenu() 照常执行；
          //    空叶子不匹配任何 action、也没有 anim，上游随即 return，**无任何副作用**。
          //    随后由我们打开真正的目标页。这样菜单关闭行为与其它项完全一致。
          if (leaf && leaf.action === 'open-site') {
            try {
              if (typeof origOnAction === 'function') origOnAction.call(this, {});
            } catch (e) {
              /* 忽略：仅用于关菜单 */
            }
            try {
              if (window.petBridge && typeof window.petBridge.openDshSite === 'function') {
                window.petBridge.openDshSite(OPEN_SITE_URL);
              } else {
                console.warn(TAG + 'petBridge.openDshSite 不可用，未能打开 ' + OPEN_SITE_URL);
              }
            } catch (e) {
              console.warn(TAG + '打开用量页失败: ' + ((e && e.message) || e));
            }
            return;
          }

          return typeof origOnAction === 'function' ? origOnAction.apply(this, arguments) : undefined;
        };
      }
    } catch (e) {
      console.warn(TAG + '菜单注入异常: ' + ((e && e.message) || e));
    }
    return origMount.apply(this, arguments);
  };

  console.log(
    TAG +
      '已启用：右键菜单追加「设置…」「退出桌宠程序」，并把「打开网站」改指 ' +
      OPEN_SITE_URL +
      '（base=' +
      (BASE || '未注入') +
      '）',
  );

  // 启动自检：确认「页面 → 本地服务」这条控制通道真的通（右键那两项走的就是它）。
  // 服务端收到会记一行日志；没那行日志就说明启动阶段有问题 —— 一眼可查，不必等用户点击才发现。
  if (BASE) {
    try {
      fetch(BASE + '/ping', { method: 'POST' }).catch(function () {});
    } catch (e) {
      /* 忽略：自检失败不影响任何功能 */
    }
  }
})();
