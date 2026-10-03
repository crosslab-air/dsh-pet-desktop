/**
 * standalone/patch-click-balance.js —— 运行期补丁（在页面主世界执行，不落盘到上游目录）
 * ============================================================================
 * 目标（用户选项 ④a）：**左键点击宠物 = 保留原生「点击回应」动画 + 同时弹出余额气泡**。
 *
 * 上游原生行为：
 *   onClick()             -> 从 animations.clicks 随机抽一段播（不回余额）
 *   右键菜单→查看余额       -> POST /balance → 立刻跑一拍 /state → showBalanceNow()
 *                            （showBalanceNow 会 playOnce 余额档位动画，抢掉前台）
 *
 * 本补丁做三件事，全部是「包一层」，不重写任何上游逻辑：
 *   ① 记录最近一次成功的余额状态（包 applyBalanceLeaf / onBalanceTick），供点击时 0 延迟取用；
 *   ② 新增 showBalanceBubbleOnly()：只点亮余额气泡（内容仍由上游 S.balanceBubbleView 生成，
 *      峰/谷着色、10 秒自动收起都沿用上游实现），**不碰动画通道**；
 *   ③ 包 onClick：先执行原生点击回应，再出气泡，并让「点击触发的这次刷新」只更新气泡不抢动画。
 *
 * 容错：每一步都做了存在性判断与 try/catch。若上游将来改了这些符号名，补丁会**静默降级**
 * （最差情况退化成「点一下照播点击回应，余额需右键查看」），绝不会让桌宠报错或白屏。
 * ============================================================================
 */
(function () {
  var TAG = '[standalone] ';
  if (window.__dshPetStandaloneClickBalance) return;
  window.__dshPetStandaloneClickBalance = true;

  var Shared = typeof S !== 'undefined' ? S : window.PetShared;
  var BUBBLE_MS = typeof BUBBLE_DURATION_MS === 'number' ? BUBBLE_DURATION_MS : 10000;

  if (typeof PetSprite === 'undefined' || !Shared) {
    console.warn(TAG + '补丁未生效：PetSprite / PetShared 未就绪');
    return;
  }

  /** 最近一次解析成功的余额状态（本补丁私有，避免依赖上游的模块级变量名） */
  var lastName = { state: null, ok: false };

  // ---------- ① 记录余额状态：包 applyBalanceLeaf（若可访问）----------
  if (typeof applyBalanceLeaf === 'function' && !applyBalanceLeaf.__standaloneWrapped) {
    var origApplyBalanceLeaf = applyBalanceLeaf;
    var wrappedApply = function (leaf) {
      try {
        var hit = Shared.readBalance(leaf);
        if (hit && hit.state && hit.state.ok) lastName = { state: hit.state, ok: true };
      } catch (e) {
        /* 记录失败不影响原生流程 */
      }
      return origApplyBalanceLeaf.apply(this, arguments);
    };
    wrappedApply.__standaloneWrapped = true;
    applyBalanceLeaf = wrappedApply; // 顶层函数声明可重赋值；events.js 内是按名调用的，故生效
  }

  // ---------- ② 只弹气泡、不抢动画 ----------
  PetSprite.prototype.showBalanceBubbleOnly = function showBalanceBubbleOnly(state) {
    if (!state || state.ok !== true) return;
    try {
      this.bubbleOn = true;
      this.balanceWrap = false; // 余额气泡是单行（nowrap），别继承上一次多行说明的换行变体
      this.balanceView = Shared.balanceBubbleView(state);
      this.renderBubble();
      if (this.bubbleTimer != null) window.clearTimeout(this.bubbleTimer);
      var self = this;
      this.bubbleTimer = window.setTimeout(function () {
        self.bubbleOn = false;
        self.renderBubble();
      }, BUBBLE_MS);
    } catch (e) {
      console.warn(TAG + 'showBalanceBubbleOnly 异常: ' + ((e && e.message) || e));
    }
  };

  // ---------- ③ 包 onBalanceTick：被点击触发的那一拍只更新气泡 ----------
  var origOnBalanceTick = PetSprite.prototype.onBalanceTick;
  PetSprite.prototype.onBalanceTick = function patchedOnBalanceTick(state, tick) {
    if (state && state.ok) lastName = { state: state, ok: true };
    if (this.__suppressBalanceAnim) {
      this.__suppressBalanceAnim = false;
      // 复刻上游的 tick 去重语义（tick 未变则本次不是新事件）
      if (typeof tick === 'number' && tick !== 0 && tick !== this.prevTick) {
        this.prevTick = tick;
        this.showBalanceBubbleOnly(state);
      }
      return;
    }
    return typeof origOnBalanceTick === 'function' ? origOnBalanceTick.apply(this, arguments) : undefined;
  };

  // ---------- ③' 包 onClick：先原生点击回应，再弹余额气泡 ----------
  var origOnClick = PetSprite.prototype.onClick;
  PetSprite.prototype.onClick = function patchedOnClick() {
    var d = this.dragState || {};
    // 与上游同一个「这次算不算真点击」判定（拖拽中/刚拖完不算）
    var realClick = !(d.active || d.dragging || this.justDragged);
    var ret = typeof origOnClick === 'function' ? origOnClick.apply(this, arguments) : undefined;
    if (!realClick) return ret;
    if (!this.pet || this.pet.balanceEnabled !== true) return ret;

    // (1) 缓存命中就立刻出气泡：点一下马上有反馈，不等网络
    if (lastName.ok && lastName.state) this.showBalanceBubbleOnly(lastName.state);

    // (2) 同时触发一次真刷新（沿用上游「查看余额」的同一路径：POST /balance + 立即拉一拍 /state）。
    //     刷新回来的那一拍被 __suppressBalanceAnim 拦下 -> 只更新气泡内容，不抢点击动画。
    this.__suppressBalanceAnim = true;
    var self = this;
    window.setTimeout(function () {
      self.__suppressBalanceAnim = false; // 刷新失败/超时也不会误吞后续周期事件的动画
    }, 3000);
    if (typeof this.showBalanceFromMenu === 'function') {
      try {
        this.showBalanceFromMenu();
      } catch (e) {
        console.warn(TAG + '触发余额刷新异常: ' + ((e && e.message) || e));
      }
    }
    return ret;
  };

  console.log(TAG + '已启用：左键点击 = 点击回应动画 + 余额气泡');
})();
