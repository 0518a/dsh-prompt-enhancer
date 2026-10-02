/**
 * dsh-prompt-enhancer —— Client 半（浏览器）。
 *
 * 这是一个手写的 DSH client bundle：不依赖任何构建工具，直接按模块系统约定的
 * `window.__ModuleLoader__.load({ id, factory })` 形式注册自己，`factory(require)`
 * 只 require 平台基线里的 `react`，因此不需要在 profile 里额外安装任何前端依赖。
 *
 * 功能：把一枚按钮注册进 `conversation.input.right`（输入框右下角、发送键之前的
 * 紧凑控件位），实现「未润色 → 润色中 → 已润色可撤销」三态交互。
 *
 * 与宿主的通信走 Connection 的通用 RPC：`ctx.get('connection').rpc.call(channel,
 * endpoint, payload)`，由 Host 半的 `/dsh-prompt-enhancer/polish` 路由应答。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    /* ------------------------------------------------------------------ */
    /* 常量                                                                */
    /* ------------------------------------------------------------------ */

    var SLOT = 'conversation.input.right';
    var CELL_ID = 'dsh-prompt-enhancer';
    var CHANNEL = '/dsh-prompt-enhancer';
    var ENDPOINT = 'polish';
    /** 注册顺序：排在其他紧凑控件之后、发送键之前，落在输入框右下角。 */
    var ORDER = 50;
    var NOTICE_MS = 6000;

    var IDLE = 'idle';
    var POLISHING = 'polishing';
    var DONE = 'done';

    var STRINGS = {
      zh: {
        idle: '润色提示词',
        busy: '正在润色提示词…',
        done: '撤销润色，恢复原始输入',
        empty: '先输入一点内容，再点叶子图标润色',
        changed: '润色期间草稿被修改，本次结果已丢弃',
        clarify: '模型的输出是在要求你补充信息，已丢弃；请重试或把草稿写得更具体',
        offline: '暂时连不上 DSH Host，无法润色',
      },
      en: {
        idle: 'Polish prompt',
        busy: 'Polishing prompt…',
        done: 'Undo polish and restore the original draft',
        empty: 'Type something first, then press the leaf button',
        changed: 'The draft changed while polishing — the result was discarded',
        clarify: 'The result asked you to clarify the draft — discarded; retry or make the draft more specific',
        offline: 'The DSH Host is unreachable right now',
      },
    };

    /* ------------------------------------------------------------------ */
    /* 纯状态机：三态切换与撤销回退的唯一真相                              */
    /* ------------------------------------------------------------------ */

    /**
     * 初始状态。
     * - `status`：idle | polishing | done，直接决定图标与点击行为。
     * - `original`：点击鲸鱼那一刻的草稿快照，撤销时回写的就是它。
     * - `polished`：交给编辑器的润色结果。
     * - `baseline`：**观测到的**「写回之后的草稿」。编辑器可能规范化文本（换行、
     *   引用芯片），所以不能假设它等于 `polished`；`null` 表示还没观测到写回落地。
     *   它就是撤销可用性的锚点：草稿一旦偏离它，说明润色结果已被用户改写或删除，
     *   撤销已经没有意义（bug 修复的核心）。
     * - `requestId`：单调递增的请求编号，用来丢弃过期响应。
     */
    var INITIAL = Object.freeze({ status: IDLE, original: '', polished: '', baseline: null, requestId: 0, notice: null, noticeKind: null });

    /** 回到未润色（清空所有快照，保留单调递增的 requestId）。 */
    function cleared(state, patch) {
      return { status: IDLE, original: '', polished: '', baseline: null, requestId: state.requestId, notice: null, noticeKind: null, ...patch };
    }

    /**
     * 状态转移（纯函数，可独立测试）。
     * @param {typeof INITIAL} state - 当前状态。
     * @param {{type: string, [k: string]: unknown}} event - 事件。
     * @returns {typeof INITIAL} 下一个状态；返回同一引用表示「无变化」。
     */
    function reduce(state, event) {
      switch (event.type) {
        case 'request': {
          if (state.status === POLISHING) return state;
          var draft = typeof event.draft === 'string' ? event.draft : '';
          if (draft.trim() === '') return { ...state, notice: 'empty', noticeKind: 'hint' };
          return { status: POLISHING, original: draft, polished: '', baseline: null, requestId: state.requestId + 1, notice: null, noticeKind: null };
        }
        case 'settle': {
          // 只接受仍然在飞、且编号匹配的那次请求。
          if (state.status !== POLISHING || event.requestId !== state.requestId) return state;
          if (typeof event.draft === 'string' && event.draft !== state.original) {
            // 用户自己改过草稿：绝不覆盖，退回未润色并提示。
            return cleared(state, { notice: 'changed', noticeKind: 'warn' });
          }
          // 模型原样返回时写回是空操作，锚点当场就是原文，无需等待观测。
          return {
            status: DONE,
            original: state.original,
            polished: event.text,
            baseline: event.text === state.original ? state.original : null,
            requestId: state.requestId,
            notice: null,
            noticeKind: null,
          };
        }
        case 'sync': {
          // 只在「已润色」态关心草稿漂移；其它态由各自的事件驱动。
          if (state.status !== DONE) return state;
          if (state.baseline === null) {
            // 写回还没被观测到（草稿仍是原文）：继续等待，避免误清撤销入口。
            if (event.draft !== state.original) return { ...state, baseline: event.draft };
            return state;
          }
          // 草稿已偏离写回结果（被改写 / 被删空）→ 撤销不再有意义，回到未润色。
          return event.draft === state.baseline ? state : cleared(state);
        }
        case 'fail': {
          if (state.status !== POLISHING || event.requestId !== state.requestId) return state;
          return cleared(state, { notice: event.message, noticeKind: 'error' });
        }
        case 'undo': {
          if (state.status !== DONE) return state;
          return cleared(state);
        }
        case 'clear-notice':
          return state.notice === null ? state : { ...state, notice: null, noticeKind: null };
        default:
          return state;
      }
    }

    /** 三态 → 图标：idle 叶子 + 闪耀 / polishing 进度环 / done 撤销箭头。 */
    function iconKindOf(status) {
      if (status === POLISHING) return 'spinner';
      if (status === DONE) return 'undo';
      return 'leaf';
    }

    /**
     * 三态 → 点击行为：idle 触发润色，done 触发撤销，polishing 忽略点击。
     * @param {string} status - 当前状态。
     * @returns {'polish'|'undo'|'none'} 该状态下点击按钮应执行的动作。
     */
    function actionOf(status) {
      if (status === POLISHING) return 'none';
      if (status === DONE) return 'undo';
      return 'polish';
    }

    /* ------------------------------------------------------------------ */
    /* 展示层兜底：绝不把「要求用户澄清」的句子写回输入框                    */
    /* ------------------------------------------------------------------ */

    /**
     * 与 Host 半同源的高信号句式。Host 半负责「检测 → 重试 → 清洗」，
     * 这里只做最后一道防线：即使 Host 版本较旧或不认识某种措辞，
     * 输入框里也绝不会出现「请先向我确认…」这类句子。
     */
    var CLARIFY_PATTERNS = [
      /请(?:先|再)?(?:向我|与我|同我|和用户|与用户)(?:确认|核实|澄清)/u,
      /(?:若|如果|倘若)[^。；\n]{0,24}(?:未提供|没有提供|未说明|无法确定|不明确|不清楚)[^。；\n]{0,24}(?:请|需|要|应先)/u,
      /(?:要求|需要|让)(?:用户|对方|执行者)(?:补充|澄清|确认)/u,
      /(?:向|跟|与)用户(?:确认|核实|询问|追问)/u,
      /(?:哪一段|哪一项|哪一个|哪一句|具体是哪个|具体指哪)/u,
      /你(?:具体)?(?:指的是|说的是|指哪个|指哪一个)/u,
      /它具体(?:指的?是|是什么)/u,
      /(?:ask|check with|confirm with|clarify with)\s+(?:the\s+)?user/iu,
    ];

    /**
     * 判断一句话是否在要求用户澄清（与草稿对照，避免误伤用户自己的措辞）。
     * @param {string} sentence - 待判定文本。
     * @param {string} draft - 本轮冻结的原始草稿。
     * @returns {boolean} 是否为澄清句。
     */
    function isClarifySentence(sentence, draft) {
      var text = typeof sentence === 'string' ? sentence.trim() : '';
      if (text === '') return false;
      if (text.length > 400 && !/[?？]/u.test(text)) return false;
      for (var i = 0; i < CLARIFY_PATTERNS.length; i += 1) {
        if (!CLARIFY_PATTERNS[i].test(text)) continue;
        if (typeof draft === 'string' && CLARIFY_PATTERNS[i].test(draft)) continue;
        return true;
      }
      return false;
    }

    /**
     * 剔除结果里要求用户澄清的句子。
     * @param {string} text - Host 返回的润色文本。
     * @param {string} draft - 本轮冻结的原始草稿。
     * @returns {string|null} 可写回的文本；`null` 表示整段结果都不可用（应当作失败处理）。
     */
    function scrubPolish(text, draft) {
      var source = typeof text === 'string' ? text.trim() : '';
      if (source === '') return null;
      if (!isClarifySentence(source, draft)) return source;
      var parts = source.split(/(?<=[。！？；!?;])\s*|\n/u);
      var kept = [];
      for (var i = 0; i < parts.length; i += 1) {
        var sentence = parts[i].trim();
        if (sentence === '') continue;
        if (!isClarifySentence(sentence, draft)) kept.push(sentence);
      }
      var result = kept.join('\n').trim();
      if (result === '' || isClarifySentence(result, draft)) return null;
      return result;
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 只画图标，不画任何底色。
     *
     * 修复「点击后出现灰/黑方块」的三条措施：
     * 1. `all:unset`——抹掉 UA 与宿主可能叠加到裸 `button` 上的样式（不少设计系统会给
     *    按钮加 hover/active 底色，那些规则将来也可能命中我们的按钮）；
     * 2. `-webkit-tap-highlight-color: transparent`——关掉触屏/触控板点击时 Chromium
     *    默认叠加的灰黑方块（shell 里只重置了 `font-family`，并没有关掉它）；
     * 3. hover/active/focus/disabled **四个态都显式声明 `background: transparent`**，
     *    hover 反馈改成只换文字色。于是「背景方块」这件事在本组件里没有任何来源。
     *
     * 键盘可达性不变：`Tab` 聚焦时仍有蓝色 `outline`（描边，不是底色）。
     */
    var CSS = [
      '.dsh-pe-button.dsh-pe-button{all:unset;box-sizing:border-box;',
      'display:inline-flex;align-items:center;justify-content:center;',
      'width:26px;height:26px;border-radius:8px;',
      'color:var(--dsw-alias-label-secondary,currentColor);background:transparent;',
      'cursor:pointer;outline:0;',
      '-webkit-tap-highlight-color:transparent;tap-highlight-color:transparent;',
      '-webkit-appearance:none;appearance:none;',
      'transition:color .15s ease;}',
      '.dsh-pe-button.dsh-pe-button:hover:not(:disabled),',
      '.dsh-pe-button.dsh-pe-button:active:not(:disabled){background:transparent;',
      'color:var(--dsw-alias-label-primary,currentColor);}',
      '.dsh-pe-button.dsh-pe-button:focus,',
      '.dsh-pe-button.dsh-pe-button:focus:not(:focus-visible){background:transparent;box-shadow:none;}',
      '.dsh-pe-button.dsh-pe-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}',
      '.dsh-pe-button.dsh-pe-button:disabled{cursor:default;background:transparent;opacity:.45;}',
      '.dsh-pe-button.dsh-pe-button[data-state="polishing"],',
      '.dsh-pe-button.dsh-pe-button[data-state="done"]{background:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);opacity:1;}',
      '.dsh-pe-button.dsh-pe-button[data-notice="error"]{color:var(--dsw-alias-state-error-primary,#e9453a);}',
      '.dsh-pe-button.dsh-pe-button[data-notice="warn"]{color:var(--dsw-alias-state-warn-primary,#e08c00);}',
      '.dsh-pe-button.dsh-pe-button svg{display:block;width:16px;height:16px;}',
      '.dsh-pe-button.dsh-pe-button[data-state="polishing"] svg{animation:dsh-pe-spin .9s linear infinite;}',
      '@keyframes dsh-pe-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}',
      '@media (prefers-reduced-motion:reduce){.dsh-pe-button.dsh-pe-button[data-state="polishing"] svg{animation-duration:2.4s;}}',
    ].join('');

    /** 注入样式标签，返回移除函数（模块系统也会认领 factory 期间插入的样式）。 */
    function injectStyles() {
      if (typeof document === 'undefined') return function () {};
      var style = document.createElement('style');
      style.setAttribute('data-plugin', CELL_ID);
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () {
        if (style.parentNode !== null) style.parentNode.removeChild(style);
      };
    }

    var removeStyles = injectStyles();

    /* ------------------------------------------------------------------ */
    /* 图标：一套统一的「圆润 + 单一 currentColor」图形语言                  */
    /* ------------------------------------------------------------------ */

    /**
     * 未润色：叶子 + 闪耀（由用户提供的 `leaf_star_vector.svg` 归一化而来）。
     *
     * 结构：**1 个 `<path>`、3 个子路径、`fill-rule="evenodd"`**：
     * ① 叶身外轮廓（37 点多边形）② 叶身内轮廓（21 点，evenodd 挖空 → 得到「描边带」观感）
     * ③ 四角闪耀（20 点，独立在左上方）。
     *
     * 归一化链路（见 `tools/verify/import-svg.mjs`，可复现）：
     * 源 viewBox 1504×1536、内容包围盒 559×606 → 等比缩放 0.0310 并居中到 24×24
     * → Douglas-Peucker 简化（容差 0.08）→ 1 位小数取整 → 省略隐式 `L` 命令。
     *
     * 质检结论（`tools/verify/test-icon.mjs`）：外轮廓 18.8 高、中心 (12,12)；
     * 内轮廓严格位于外轮廓内部，描边带厚 1.59~2.61（均值 1.78，与进度环 2.2 / 撤销箭头 2 同族）；
     * 闪耀与叶身带的最小间距 > 1（不会互相挖洞）。
     */
    var LEAF_STAR_PATH =
      'M20.5 3.9 19.9 3.7 19.2 3.7 17.6 3.9 15.2 4.7 13.8 5.4 12.1 6.5 10.1 8.6 8.5 10.9 7.5 13 7.1 14.5 6.6 16.3 6.5 17.9 6.5 20.2 6.6 20.8 6.8 21.2 7.5 21.4 8 21.1 8.2 20.8 8.3 19.7 8.6 18.5 9.1 17.6 9.8 16.9 10.6 16.5 12.6 16 14.8 15 16.8 13.6 17.8 12.4 18.5 11.3 18.7 10.6 18.7 10 18.3 9.3 18.3 9.1 19.2 7.8 20.3 6 20.7 4.9 20.7 4.4M18.3 5.6 18.4 5.7 18.4 6 17.8 6.9 15.6 9.1 15.7 9.3 16.6 9.8 17 10.3 16.9 10.8 16 12 14.7 13.1 12.9 14 8.8 15.3 8.7 14.9 9.1 13.9 10.1 11.6 11.2 10 12.1 8.9 13.3 7.8 14.5 6.9 16.8 6M6.1 2.6 5.3 4.1 4.6 4.7 3.4 5.3 3.3 5.5 3.6 5.8 5.1 6.6 5.5 7 6.1 8.3 6.3 8.4 6.5 8.2 7 7.1 7.4 6.6 7.8 6.3 8.9 5.8 9.2 5.5 9.1 5.3 7.5 4.5 6.9 3.7 6.4 2.7Z';

    /**
     * 已润色：圆润的撤销箭头（描边 2，与鲸鱼的圆角语言一致）。
     * 左箭头 + 右凸半圆回钩，包围盒（含描边）约 17×17，
     * 视觉尺寸与鲸鱼 / 进度环持平，切换状态时不会跳动。
     */
    var UNDO_PATH = 'M8.3 4.3 4.3 8.1 8.3 11.9M4.3 8.1H13.7A5.6 5.6 0 0 1 13.7 19.3H8.9';

    /** 润色中：进度环（轨道 + 90° 圆头弧，整体旋转）。半径与外径对齐鲸鱼宽度。 */
    var RING_RADIUS = 8;
    var RING_STROKE = 2.2;
    /** 2πr ≈ 50.27；取 ~1/4 圈作亮弧，其余留空。 */
    var RING_ARC = '12.6 37.7';

    /**
     * 渲染当前状态对应的图标（每个分支都只产出最小节点集）。
     * @param {string} kind - leaf | spinner | undo。
     * @returns {object} React 元素。
     */
    function renderIcon(kind) {
      if (kind === 'spinner') {
        return React.createElement(
          'svg',
          { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
          React.createElement('circle', {
            cx: '12',
            cy: '12',
            r: String(RING_RADIUS),
            fill: 'none',
            stroke: 'currentColor',
            strokeOpacity: '0.22',
            strokeWidth: String(RING_STROKE),
          }),
          React.createElement('circle', {
            cx: '12',
            cy: '12',
            r: String(RING_RADIUS),
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: String(RING_STROKE),
            strokeLinecap: 'round',
            strokeDasharray: RING_ARC,
          }),
        );
      }
      if (kind === 'undo') {
        return React.createElement(
          'svg',
          { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
          React.createElement('path', {
            d: UNDO_PATH,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: '2',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        );
      }
      return React.createElement(
        'svg',
        { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', { d: LEAF_STAR_PATH, fill: 'currentColor', fillRule: 'evenodd' }),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 运行期上下文与 Host 调用                                            */
    /* ------------------------------------------------------------------ */

    /** apply 时捕获的 Client 上下文（只在闭包里读服务，不持有其它状态）。 */
    var runtime = { ctx: null };

    /** 当前界面语言是否中文。 */
    function isZh() {
      try {
        var locale = runtime.ctx && runtime.ctx.get ? runtime.ctx.get('locale') : undefined;
        var active = locale && typeof locale.getLocale === 'function' ? locale.getLocale().active : undefined;
        if (typeof active === 'string' && active !== '') return active.toLowerCase().indexOf('zh') === 0;
      } catch {
        /* 语言服务缺席时退回浏览器语言 */
      }
      var language = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : 'zh';
      return language.toLowerCase().indexOf('zh') === 0;
    }

    /** 取当前语言的一整套文案。 */
    function strings() {
      return isZh() ? STRINGS.zh : STRINGS.en;
    }

    /**
     * 调 Host 半的润色通道。
     * @param {{text: string, sessionId?: string, locale: string}} payload - 请求负载。
     * @returns {Promise<string>} 润色后的提示词。
     */
    function callHost(payload) {
      var connection = runtime.ctx && runtime.ctx.get ? runtime.ctx.get('connection') : undefined;
      var rpc = connection && connection.rpc;
      if (rpc === undefined || typeof rpc.call !== 'function') return Promise.reject(new Error(strings().offline));
      return Promise.resolve(rpc.call(CHANNEL, ENDPOINT, payload)).then(function (result) {
        if (result !== null && typeof result === 'object' && result.ok === true) {
          var value = result.value;
          if (value !== null && typeof value === 'object' && typeof value.text === 'string' && value.text.trim() !== '') return value.text;
          throw new Error('Host 返回了空的润色结果');
        }
        var error = result !== null && typeof result === 'object' ? result.error : undefined;
        throw new Error(error !== undefined && typeof error.message === 'string' ? error.message : 'polish failed');
      });
    }

    /* ------------------------------------------------------------------ */
    /* 组件                                                                */
    /* ------------------------------------------------------------------ */

    /** 没有 useInput 注入时的占位 Hook（保持 Hook 调用顺序稳定）。 */
    function useNothing() {
      return undefined;
    }

    /**
     * 输入框右下角的提示词增强按钮。
     * @param {object} props - 插槽标准 props：`useInput` / `inputActions` / `sessionId`。
     * @returns {object} React 元素。
     */
    function PromptEnhancerButton(props) {
      var useInput = typeof props.useInput === 'function' ? props.useInput : useNothing;
      var inputActions = props.inputActions;
      var input = useInput(function (state) {
        return state;
      });

      var stateRef = React.useRef(INITIAL);
      var result = React.useState(INITIAL);
      var state = result[0];
      var setState = result[1];
      var inputRef = React.useRef(input);
      inputRef.current = input;
      /** 本次渲染观察到的草稿（作为 effect 依赖，也是渲染期判定的唯一来源）。 */
      var draftNow = input !== undefined && input !== null && typeof input.draft === 'string' ? input.draft : '';

      /** 事件回调里读取最新草稿（拿不到时视作空串）。 */
      function draftOf() {
        var current = inputRef.current;
        return current !== undefined && current !== null && typeof current.draft === 'string' ? current.draft : '';
      }

      /** 提交一个新状态（同一引用表示无变化）。 */
      function commit(next) {
        if (next === stateRef.current) return;
        stateRef.current = next;
        setState(next);
      }

      /**
       * 草稿漂移同步（bug 修复）：
       * 润色完成进入 done 后，一旦草稿不再等于「写回结果」（用户删空、改写、
       * 或编辑器规范化后又被编辑），撤销入口立即失效并退回未润色状态。
       * 写回落地的第一帧不在这里判定——`baseline === null` 时会等观测到实际草稿。
       */
      React.useEffect(function () {
        commit(reduce(stateRef.current, { type: 'sync', draft: draftNow }));
      }, [state.status, state.baseline, draftNow]);

      function onPolish() {
        var draft = draftOf();
        var next = reduce(stateRef.current, { type: 'request', draft: draft });
        commit(next);
        if (next.status !== POLISHING) return;
        var requestId = next.requestId;
        callHost({ text: draft, sessionId: props.sessionId, locale: isZh() ? 'zh' : 'en' }).then(
          function (text) {
            var previous = stateRef.current;
            // 展示层兜底：先剔除「要求用户澄清」的句子，剔除后为空则按失败处理。
            var accepted = scrubPolish(text, previous.original);
            if (accepted === null) {
              commit(reduce(previous, { type: 'fail', requestId: requestId, message: strings().clarify }));
              return;
            }
            var settled = reduce(previous, { type: 'settle', requestId: requestId, text: accepted, draft: draftOf() });
            var wroteBack = settled.status === DONE && settled.polished === accepted;
            commit(settled);
            if (wroteBack && inputActions !== undefined && typeof inputActions.setDraft === 'function') {
              // 唯一一次写回：撤销时回写 state.original，二者严格配对。
              inputActions.setDraft(accepted);
            }
          },
          function (error) {
            commit(reduce(stateRef.current, { type: 'fail', requestId: requestId, message: error instanceof Error ? error.message : String(error) }));
          },
        );
      }

      function onUndo() {
        var previous = stateRef.current;
        if (previous.status !== DONE) return;
        var current = draftOf();
        commit(reduce(previous, { type: 'undo' }));
        // 只有在草稿仍等于写回结果时才回退，避免覆盖用户后续输入。
        var anchor = previous.baseline === null ? previous.polished : previous.baseline;
        if (current === anchor && inputActions !== undefined && typeof inputActions.setDraft === 'function') {
          inputActions.setDraft(previous.original);
        }
      }

      // 提示（空草稿 / 草稿被改 / 失败）只做短暂提示，随后自动消失。
      React.useEffect(function () {
        if (state.notice === null) return undefined;
        var timer = setTimeout(function () {
          commit(reduce(stateRef.current, { type: 'clear-notice' }));
        }, NOTICE_MS);
        return function () {
          clearTimeout(timer);
        };
      }, [state.notice]);

      // 语言切换后重绘一次，让 tooltip 跟随当前语言。
      var tick = React.useState(0);
      React.useEffect(function () {
        var locale = runtime.ctx && runtime.ctx.get ? runtime.ctx.get('locale') : undefined;
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(function () {
          tick[1](function (n) {
            return n + 1;
          });
        });
      }, []);

      if (input === undefined || input === null) return null;

      var t = strings();
      var status = state.status;
      var action = actionOf(status);
      var icon = iconKindOf(status);
      var hasDraft = draftNow.trim() !== '';
      var notice = state.notice;
      var noticeText = notice === null ? null : notice === 'empty' ? t.empty : notice === 'changed' ? t.changed : notice;
      var title = noticeText !== null ? noticeText : action === 'undo' ? t.done : action === 'none' ? t.busy : hasDraft ? t.idle : t.empty;
      var locked = input.phase === 'submitting' || input.phase === 'adjudicating';

      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-pe-button',
          'data-plugin': CELL_ID,
          'data-state': status,
          'data-notice': notice === null ? undefined : state.noticeKind,
          'aria-label': title,
          title: title,
          disabled: action === 'none' || locked || (action === 'polish' && !hasDraft),
          // 点击时不让按钮抢焦点：焦点一旦落到按钮上，宿主/父级任何 :focus / :focus-within
          // 样式都可能给这个格子铺一层底色（就是用户看到的「黑框」的来源之一）。
          // preventDefault 只阻止获取焦点与拖选，不会取消随后的 click，键盘 Tab 聚焦照常。
          onMouseDown: function (event) {
            if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
          },
          onClick: action === 'undo' ? onUndo : action === 'polish' ? onPolish : undefined,
        },
        renderIcon(icon),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 插件入口                                                            */
    /* ------------------------------------------------------------------ */

    /** Client 服务依赖：只需要插槽注册表；connection / locale 走惰性读取。 */
    var inject = ['slots'];

    /**
     * 注册到输入框右下角的紧凑控件位。
     * @param {object} ctx - Client 根上下文。
     */
    function apply(ctx) {
      runtime.ctx = ctx;
      ctx.effect(function () {
        return removeStyles;
      }, 'dsh-prompt-enhancer: styles');

      ctx.inject(['slots'], function (scope) {
        scope.slots.inject(SLOT, function () {
          return scope.slots.register(
            {
              name: SLOT,
              id: CELL_ID,
              order: ORDER,
            },
            PromptEnhancerButton,
          );
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    /** 测试钩子：纯状态机、行为映射与图标路径，便于在没有浏览器的情况下验证三态与图形。 */
    exports.__internals = {
      SLOT: SLOT,
      CHANNEL: CHANNEL,
      ENDPOINT: ENDPOINT,
      ORDER: ORDER,
      INITIAL: INITIAL,
      LEAF_STAR_PATH: LEAF_STAR_PATH,
      UNDO_PATH: UNDO_PATH,
      RING_RADIUS: RING_RADIUS,
      RING_ARC: RING_ARC,
      reduce: reduce,
      isClarifySentence: isClarifySentence,
      scrubPolish: scrubPolish,
      CLARIFY_PATTERNS: CLARIFY_PATTERNS,
      actionOf: actionOf,
      iconKindOf: iconKindOf,
      PromptEnhancerButton: PromptEnhancerButton,
      setContext: function (ctx) {
        runtime.ctx = ctx;
      },
    };

    return module.exports;
  },
});
