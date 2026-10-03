/**
 * standalone/patch-sound.js —— 运行期补丁：点击音效（在页面主世界执行，不落盘到上游目录）
 * ============================================================================
 * 为什么需要独立补丁：上游 dsh-pet **完全没有音频能力** ——
 *   · assets/webm 的 106 段动画是纯 VP9（EBML 里 TrackType 只有 video，无 audio track）；
 *   · 上游源码与 config.jsonc 里零 audio / sound 引用；
 *   · sprite.js 反而显式把所有 <video> 设成 muted（自动播放策略需要）。
 * 所以音效不能从动画里"解静音"得到，必须自己播。
 *
 * 音效来源：本地服务的 /sound/<音效组>-<press|release>.mp3（standalone/sound/，4 枚原创合成音，
 * 生成脚本见 scripts/make-sounds.py；想换素材直接替换同名文件即可）。
 * 页面 CSP 已允许（index.html: media-src 'self' http: https: blob:），无需改上游。
 *
 * 触发时机（按下 / 松开各一声，手感自然）：
 *   ① 左键在宠物命中区（.pet-hit）按下 → 播「按下」音
 *   ② 左键松开 → 播「松开」音（仅当刚才那一下按在宠物上，避免点空白处出声）
 *   拖拽同理：拿起响一下、放下响一下。
 *
 * 配置从 window.__standaloneSound 读：{ on, vol, set }
 *   由 Electron 主进程在注入时写入，设置窗口改动后**实时下发**（无需重启）。
 *   每次播放都重新读取，故改音量/音效组立刻生效。
 *
 * 容错：任何一步异常都静默吞掉（最差情况 = 没有音效），绝不影响桌宠本体。
 * ============================================================================
 */
(function () {
  var TAG = '[standalone] ';
  if (window.__dshPetStandaloneSound) return;
  window.__dshPetStandaloneSound = true;

  var DEFAULT_CFG = { on: true, vol: 0.68, set: 'duck' };

  /** 读取当前音效配置（主进程下发；缺字段一律回落默认值） */
  function readCfg() {
    var c = window.__standaloneSound;
    if (!c || typeof c !== 'object') return DEFAULT_CFG;
    return {
      on: c.on !== false,
      vol:
        typeof c.vol === 'number' && isFinite(c.vol) && c.vol >= 0 && c.vol <= 1
          ? c.vol
          : DEFAULT_CFG.vol,
      set: typeof c.set === 'string' && c.set ? c.set : DEFAULT_CFG.set,
    };
  }

  /**
   * 服务基址。正常由主进程注入 window.__standaloneBase；
   * 兜底与 patch-shell.js 一致：从页面自己的 CONFIG.configUrl 反推（末段为 /config 的路径前缀）。
   */
  function baseNow() {
    if (window.__standaloneBase) return window.__standaloneBase;
    try {
      var cfg = typeof CONFIG !== 'undefined' ? CONFIG : window.CONFIG;
      var u = cfg && cfg.configUrl;
      if (typeof u === 'string' && u) {
        var m = u.match(/^(https?:\/\/[^/]+)(\/[^/?#]+)/);
        if (m) return m[1] + m[2];
      }
    } catch (e) {
      /* 兜底失败 -> 返回空串，调用方会直接放弃播放 */
    }
    return '';
  }

  /** 正在播放的音频对象，避免被提前回收；上限 6 个，超出丢弃最旧的 */
  var live = [];

  function play(kind) {
    try {
      var c = readCfg();
      if (!c.on) {
        window.__standaloneSoundSkipped = (window.__standaloneSoundSkipped || 0) + 1;
        window.__standaloneSoundSkipReason = 'disabled';
        return;
      }
      var base = baseNow();
      if (!base) {
        window.__standaloneSoundSkipped = (window.__standaloneSoundSkipped || 0) + 1;
        window.__standaloneSoundSkipReason = 'no-base';
        return;
      }
      var url = base + '/sound/' + c.set + '-' + kind + '.mp3';
      var a = new Audio(url);
      a.volume = c.vol;
      // 可观测性：供外部自检（如 CDP）确认音效确实被触发过
      window.__standaloneSoundPlayed = (window.__standaloneSoundPlayed || 0) + 1;
      window.__standaloneSoundLast = { kind: kind, url: url, vol: c.vol, at: Date.now() };
      var drop = function () {
        var i = live.indexOf(a);
        if (i >= 0) live.splice(i, 1);
      };
      a.addEventListener('ended', drop);
      a.addEventListener('error', drop);
      live.push(a);
      while (live.length > 6) {
        var old = live.shift();
        try {
          old.pause();
        } catch (e) {
          /* 忽略 */
        }
      }
      var p = a.play();
      if (p && typeof p.catch === 'function') p.catch(drop); // 自动播放被拒：静默放弃
    } catch (e) {
      /* 音效失败绝不影响桌宠 */
    }
  }

  /** 事件目标是否落在宠物命中区（命中区见 index.html 的 .pet-hit） */
  function isPetEl(el) {
    try {
      return !!(el && el.closest && el.closest('.pet-hit'));
    } catch (e) {
      return false;
    }
  }

  // 捕获阶段监听：先于上游拿到事件，只读不改，不影响上游的拖拽/点击判定
  var downOnPet = false;

  document.addEventListener(
    'pointerdown',
    function (ev) {
      if (ev.button !== 0) {
        downOnPet = false;
        return;
      }
      downOnPet = isPetEl(ev.target);
      if (downOnPet) play('press');
    },
    true,
  );

  document.addEventListener(
    'pointerup',
    function (ev) {
      if (ev.button !== 0) {
        downOnPet = false;
        return;
      }
      if (downOnPet) play('release');
      downOnPet = false;
    },
    true,
  );

  // 拖拽被系统中断 / 指针离开窗口：别让下一次松开误响
  document.addEventListener(
    'pointercancel',
    function () {
      downOnPet = false;
    },
    true,
  );

  var now = readCfg();
  console.log(
    TAG +
      '已启用：点击音效（组=' +
      now.set +
      '，音量=' +
      now.vol +
      '，开关=' +
      (now.on ? '开' : '关') +
      '，配置=' +
      (window.__standaloneSound ? '已注入' : '缺省') +
      '，base=' +
      (baseNow() ? '就绪' : '待注入') +
      '）',
  );

  // 暴露给主进程做设置变更时的即时自检（无副作用）
  window.__standaloneSoundState = readCfg;
})();
