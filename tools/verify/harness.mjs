/**
 * 极简 React / DOM 替身：只实现 dsh-prompt-enhancer 的 Client 半用到的那一小撮 API，
 * 让浏览器半可以在 Node 里被真实地挂载、点击、重绘与断言。
 *
 * 支持：createElement、useState、useRef、useEffect（含依赖比较与清理）。
 * 不支持：并发渲染、Context、memo 等（本插件都不需要）。
 */

/**
 * 创建一个 React 门面：它就是 bundle 里 `require('react')` 的返回值。
 * 每个门面持有自己的「当前渲染上下文」，因此同一个进程里可以并存多个独立挂载。
 * @returns {object} React 门面。
 */
export function createReactFacade() {
  let context = null;

  const facade = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState(initial) {
      if (context === null) throw new Error('useState called outside a render');
      return context.useState(initial);
    },
    useRef(initial) {
      if (context === null) throw new Error('useRef called outside a render');
      return context.useRef(initial);
    },
    useEffect(effect, deps) {
      if (context === null) throw new Error('useEffect called outside a render');
      return context.useEffect(effect, deps);
    },
  };

  Object.defineProperty(facade, '__context', {
    get: () => context,
    set: (next) => {
      context = next;
    },
  });

  return facade;
}

/**
 * 用给定 React 门面挂载一个函数组件，并保留 Hook 状态以便手动重绘。
 * @param {(props: object) => unknown} Component - 函数组件。
 * @param {object} props - 初始 props。
 * @param {object} [facade] - `createReactFacade()` 的产物；缺省时现场创建一个。
 * @returns {object} 渲染器：tree / render / click / setProps / unmount。
 */
export function mount(Component, props, facade = createReactFacade()) {
  const hooks = [];
  const liveCleanups = new Map();
  let cursor = 0;
  let tree;
  let currentProps = props;
  let dirty = false;

  const context = {
    useState(initial) {
      const index = cursor++;
      if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = hooks[index];
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next;
          if (Object.is(value, slot.value)) return;
          slot.value = value;
          dirty = true;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (hooks[index] === undefined) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const slot = hooks[index] ?? { deps: undefined, cleanup: undefined, index };
      hooks[index] = slot;
      const sameDeps =
        deps !== undefined && slot.deps !== undefined && deps.length === slot.deps.length && deps.every((dep, i) => Object.is(dep, slot.deps[i]));
      if (sameDeps) return;
      slot.deps = deps;
      if (typeof slot.cleanup === 'function') {
        slot.cleanup();
        liveCleanups.delete(index);
      }
      const cleanup = effect();
      if (typeof cleanup === 'function') {
        slot.cleanup = cleanup;
        liveCleanups.set(index, cleanup);
      }
    },
  };

  function render() {
    cursor = 0;
    dirty = false;
    facade.__context = context;
    try {
      tree = Component(currentProps);
    } finally {
      facade.__context = null;
    }
    // 本次渲染未触及的 Hook 槽位不再存活，其清理函数立即执行。
    for (const [index, cleanup] of [...liveCleanups]) {
      if (index >= cursor) {
        cleanup();
        liveCleanups.delete(index);
      }
    }
  }

  render();

  /** 反复渲染直到没有新的状态更新（模拟 React 的提交 + effect 循环）。 */
  function settle() {
    let rounds = 0;
    while (dirty) {
      if (++rounds > 50) throw new Error('render did not stabilize (effect loop?)');
      render();
    }
  }

  return {
    facade,
    get tree() {
      return tree;
    },
    get props() {
      return currentProps;
    },
    /**
     * 组件在 hooks 里改过状态时重绘（模拟 React 的提交阶段）。
     * 本替身在渲染过程中同步执行 effect，因此 effect 里的 setState 也需要一次
     * 新的渲染——循环到稳定为止，正是 React「提交 → effect → 再提交」的行为。
     */
    commit: settle,
    /** 无视 dirty 标记强制重绘（用于外部数据源变化，例如草稿被改写）。 */
    forceRender: forceRenderAndSettle,
    setProps(next) {
      currentProps = { ...currentProps, ...next };
      render();
      settle();
    },
    /** 找到第一个满足条件的节点并调用它的 onClick，随后提交。 */
    click(predicate) {
      const node = findNode(tree, predicate);
      if (node === undefined) throw new Error('click target not found');
      if (typeof node.props.onClick !== 'function') throw new Error('click target has no onClick');
      node.props.onClick({ preventDefault() {}, stopPropagation() {} });
      settle();
      return node;
    },
    unmount() {
      for (const cleanup of liveCleanups.values()) cleanup();
      liveCleanups.clear();
    },
  };

  /** 强制重绘一次，并把 effect 引起的新状态一并提交。 */
  function forceRenderAndSettle() {
    render();
    settle();
  }
}

/**
 * 深度优先查找第一个满足条件的元素节点。
 * @param {unknown} node - 起始节点。
 * @param {(node: object) => boolean} predicate - 判定函数。
 * @returns {object|undefined} 命中的节点。
 */
export function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node.type === undefined) return undefined;
  if (predicate(node)) return node;
  return findNode(node.props?.children, predicate);
}

/**
 * 收集树中的全部元素节点。
 * @param {unknown} node - 起始节点。
 * @param {object[]} out - 累积数组。
 * @returns {object[]} 所有元素节点。
 */
export function allNodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) allNodes(child, out);
    return out;
  }
  if (node.type === undefined) return out;
  out.push(node);
  allNodes(node.props?.children, out);
  return out;
}

/** 把元素树序列化成近似 HTML 的字符串，便于快照式断言。 */
export function toHtml(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node !== 'object') return String(node);
  const attrs = Object.entries(node.props ?? {})
    .filter(([key]) => key !== 'children' && key !== 'onClick')
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(' ');
  return `<${node.type}${attrs === '' ? '' : ` ${attrs}`}>${toHtml(node.props?.children)}</${node.type}>`;
}

/** 等待挂起的微任务队列清空。 */
export function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 造一个只用于样式注入的 document 替身。 */
export function createFakeDocument() {
  const head = {
    children: [],
    appendChild(node) {
      head.children.push(node);
      node.parentNode = head;
    },
    removeChild(node) {
      head.children = head.children.filter((child) => child !== node);
      node.parentNode = null;
    },
  };
  return {
    head,
    createElement() {
      return {
        parentNode: null,
        attributes: {},
        textContent: '',
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
    },
  };
}

/** 极简断言。 */
export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** 断言两个值严格相等。 */
export function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
