/**
 * Client 半验证：真实加载 `lib/client/index.js` 这份手写 bundle，
 * 挂载三态按钮，逐步走完「未润色 → 润色中 → 已润色 → 撤销」、草稿漂移复位，
 * 以及各条异常路径。
 *
 * 运行：node tools/verify/test-client.mjs
 */

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allNodes, assert, assertEqual, createFakeDocument, createReactFacade, findNode, flush, mount, toHtml } from './harness.mjs';

const CLIENT_PATH = fileURLToPath(new URL('../../lib/client/index.js', import.meta.url));
const PACKAGE_ID = 'dsh-prompt-enhancer';
const SLOT = 'conversation.input.right';
/** 图标路径的开头，用于从渲染树里认出当前画的是哪一个。 */
const LEAF_HEAD = 'M20.5 3.9';
const UNDO_HEAD = 'M8.3 4.3';

let failures = 0;
let checks = 0;

/** 一条断言用例：抛错即记失败并继续跑后面的用例。 */
function test(name, body) {
  checks += 1;
  try {
    body();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function testAsync(name, body) {
  checks += 1;
  try {
    await body();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 1. 加载 bundle：全局替身 → ModuleLoader.load → factory(require)             */
/* -------------------------------------------------------------------------- */

const fakeDocument = createFakeDocument();
let registration;
const sandboxWindow = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry;
    },
  },
};
globalThis.window = sandboxWindow;
globalThis.document = fakeDocument;

const source = readFileSync(CLIENT_PATH, 'utf8');
vm.runInThisContext(source, { filename: CLIENT_PATH });

console.log('\n[1] bundle 注册与导出面');

test('bundle 用包名注册自己', () => {
  assert(registration !== undefined, 'window.__ModuleLoader__.load 未被调用');
  assertEqual(registration.id, PACKAGE_ID, 'bundle id 必须等于包名');
  assertEqual(typeof registration.factory, 'function', 'factory 必须是函数');
});

const facade = createReactFacade();
const clientExports = registration.factory((specifier) => {
  if (specifier === 'react') return facade;
  throw new Error(`unexpected require("${specifier}")`);
});

test('导出 apply / inject', () => {
  assertEqual(typeof clientExports.apply, 'function', 'apply');
  assertEqual(typeof clientExports.inject, typeof clientExports.inject === null ? 'null' : typeof clientExports.inject, 'inject 要有类型');
  assert(Array.isArray(clientExports.inject), 'inject 必须是数组');
  assert(clientExports.inject.includes('slots'), 'inject 必须包含 slots');
});

test('factory 期间注入了样式标签', () => {
  assertEqual(fakeDocument.head.children.length, 1, '应有一个 <style>');
  assertEqual(fakeDocument.head.children[0].attributes['data-plugin'], PACKAGE_ID, '样式标签带 data-plugin 标记');
});

test('按钮样式不画任何底色（回归：点击后出现灰/黑方块）', () => {
  const css = fakeDocument.head.children[0].textContent;
  assert(css.includes('all:unset'), '应抹掉 UA / 宿主叠加到 button 上的样式');
  assert(css.includes('-webkit-tap-highlight-color:transparent'), '应关掉触屏点击高亮');
  assert(css.includes('-webkit-appearance:none'), '应关掉原生控件外观');
  const painted = [...css.matchAll(/background(?:-color)?\s*:\s*([^;}]+)/gu)].map((match) => match[1].trim());
  assert(painted.length >= 4, `background 应覆盖 base/hover/active/focus/disabled 各状态，实际 ${painted.length} 处`);
  for (const value of painted) assertEqual(value, 'transparent', `按钮任何状态下背景都必须是 transparent，实际 ${value}`);
});

/* -------------------------------------------------------------------------- */
/* 2. apply：注册到 conversation.input.right                                   */
/* -------------------------------------------------------------------------- */

console.log('\n[2] 插槽注册');

let rpcCalls = [];
let pendingRpc = null;
const rpc = {
  call(channel, endpoint, payload) {
    rpcCalls.push({ channel, endpoint, payload });
    return new Promise((resolve, reject) => {
      pendingRpc = { resolve, reject };
    });
  },
};

let registeredSpec = null;
let registeredComponent = null;
let injectedSlots = [];

const ctx = {
  get(name) {
    return name === 'connection' ? { rpc } : undefined;
  },
  effect(factory, label) {
    assertEqual(typeof label, 'string', 'effect 需要 label');
    return factory();
  },
  inject(keys, callback) {
    assert(keys.includes('slots'), 'apply 必须 inject slots');
    callback({
      slots: {
        inject(slot, declaration) {
          injectedSlots.push(slot);
          return declaration();
        },
        register(spec, Component) {
          registeredSpec = spec;
          registeredComponent = Component;
          return () => {};
        },
      },
    });
  },
};

test('apply 把按钮注册进右下角控件位', () => {
  clientExports.apply(ctx);
  assertEqual(injectedSlots.length, 1, '只注入一个插槽');
  assertEqual(injectedSlots[0], SLOT, '插槽名必须是 conversation.input.right');
  assertEqual(registeredSpec.name, SLOT, '注册名');
  assertEqual(registeredSpec.id, PACKAGE_ID, '单元格 id');
  assertEqual(registeredSpec.order, 50, '排序值');
  assertEqual(typeof registeredComponent, 'function', '注册了一个组件');
});

/* -------------------------------------------------------------------------- */
/* 3. 三态交互                                                                 */
/* -------------------------------------------------------------------------- */

const ORIGINAL = '帮我查询有关目前的科技发展的前景';
const POLISHED = '## 目标\n请检索并汇总当前科技发展的主要前景。';

/** 造一份「草稿 + inputActions」的受控环境；`normalize` 可模拟编辑器的文本规范化。 */
function makeComposer(draft = ORIGINAL, normalize = (text) => text) {
  const state = { draft, draftRev: 1, phase: 'plain', attachmentIds: [] };
  return {
    state,
    useInput: (selector) => selector(state),
    inputActions: {
      setDraft(text) {
        const next = normalize(text);
        if (next === state.draft) return;
        state.draft = next;
        state.draftRev += 1;
      },
    },
    /** 外部直接改写草稿（模拟用户输入 / 删除）。 */
    type(text) {
      state.draft = text;
      state.draftRev += 1;
    },
  };
}

/** 延迟落地写回的编辑器替身：用于验证「写回还没落地时不误清撤销」。 */
function makeLazyComposer(draft = ORIGINAL) {
  const state = { draft, draftRev: 1, phase: 'plain', attachmentIds: [] };
  let pending = null;
  return {
    state,
    useInput: (selector) => selector(state),
    inputActions: {
      setDraft(text) {
        pending = text;
      },
    },
    /** 把挂起的写回真正提交给编辑器。 */
    applyWrite() {
      if (pending === null) return false;
      state.draft = pending;
      state.draftRev += 1;
      pending = null;
      return true;
    },
    /** 外部直接改写草稿（模拟用户输入 / 删除）。 */
    type(text) {
      state.draft = text;
      state.draftRev += 1;
    },
  };
}

/** 按钮节点选择器。 */
const buttonOf = (node) => node.type === 'button' && node.props['data-plugin'] === PACKAGE_ID;
/** 当前按钮节点。 */
const button = (renderer) => findNode(renderer.tree, buttonOf);
/**
 * 当前图标种类，顺带校验每个状态的图形要素（填充 / 描边 / 节点数）。
 * @returns {'leaf'|'spinner'|'undo'|'other'|'none'}
 */
function iconOf(renderer) {
  const nodes = allNodes(renderer.tree);
  const circles = nodes.filter((node) => node.type === 'circle');
  if (circles.length > 0) {
    // 进度环 = 轨道 + 亮弧，两个 circle 都是纯描边。
    const ok = circles.length === 2 && circles.every((node) => node.props.fill === 'none' && node.props.stroke === 'currentColor');
    return ok ? 'spinner' : 'other';
  }
  const paths = nodes.filter((node) => node.type === 'path');
  if (paths.length === 0) return 'none';
  // idle = 单个 evenodd 填充路径（叶身外轮廓 + 内轮廓挖空 + 闪耀）
  const leaf = paths.find((node) => String(node.props.d).startsWith(LEAF_HEAD));
  if (leaf !== undefined) {
    const ok = leaf.props.fill === 'currentColor' && leaf.props.fillRule === 'evenodd' && leaf.props.stroke === undefined;
    return ok && paths.length === 1 ? 'leaf' : 'other';
  }
  const path = paths[0];
  if (String(path.props.d).startsWith(UNDO_HEAD)) {
    return path.props.stroke === 'currentColor' && path.props.fill === 'none' ? 'undo' : 'other';
  }
  return 'other';
}

console.log('\n[3] 状态 1：未润色（叶子图标）');

const composer = makeComposer();
const renderer = mount(registeredComponent, { useInput: composer.useInput, inputActions: composer.inputActions, sessionId: 'session-1' }, facade);

test('初始渲染是叶子按钮', () => {
  assert(button(renderer) !== undefined, '找到按钮');
  assertEqual(button(renderer).props['data-state'], 'idle', 'data-state');
  assertEqual(iconOf(renderer), 'leaf', '图标');
  assertEqual(button(renderer).props.title, '润色提示词', '中文 tooltip');
  assertEqual(button(renderer).props.disabled, false, '有草稿时可点击');
});

test('点击时不让按钮抢焦点（避免宿主 :focus / :focus-within 铺底色）', () => {
  const node = button(renderer);
  assertEqual(typeof node.props.onMouseDown, 'function', '需要 onMouseDown');
  let prevented = 0;
  node.props.onMouseDown({ preventDefault() { prevented += 1; } });
  assertEqual(prevented, 1, '应调用 preventDefault');
  node.props.onMouseDown(undefined); // 事件缺失时也不能崩
});

test('渲染结果可序列化（结构自检）', () => {
  const html = toHtml(renderer.tree);
  assert(html.includes('data-plugin="dsh-prompt-enhancer"'), '带插件标记');
  assert(html.includes('<path'), '包含图标 path');
});

test('idle 图标就是导出的叶子矢量（逐字符一致 + evenodd）', () => {
  const paths = allNodes(renderer.tree).filter((node) => node.type === 'path');
  assertEqual(paths.length, 1, 'idle 只有一个 path（叶身 + 挖空 + 闪耀共用一条路径）');
  assertEqual(String(paths[0].props.d), clientExports.__internals.LEAF_STAR_PATH, 'd 必须等于常量');
  assertEqual(paths[0].props.fill, 'currentColor', '填充当前色');
  assertEqual(paths[0].props.fillRule, 'evenodd', '必须用 evenodd（内轮廓才是挖空）');
});

console.log('\n[4] 点击 → 状态 2：润色中（进度环）');

let requestedPayload = null;
test('点击叶子后进入 polishing 并发出唯一一次 RPC', () => {
  rpcCalls = [];
  renderer.click(buttonOf);
  assertEqual(rpcCalls.length, 1, 'RPC 调用次数');
  assertEqual(rpcCalls[0].channel, '/dsh-prompt-enhancer', '通道');
  assertEqual(rpcCalls[0].endpoint, 'polish', 'endpoint');
  requestedPayload = rpcCalls[0].payload;
  assertEqual(requestedPayload.text, ORIGINAL, '带上原始草稿');
  assertEqual(requestedPayload.sessionId, 'session-1', '带上 sessionId');
  assertEqual(button(renderer).props['data-state'], 'polishing', 'data-state');
  assertEqual(iconOf(renderer), 'spinner', '图标切到进度环');
  assertEqual(button(renderer).props.disabled, true, '润色中不可重复点击');
  assertEqual(button(renderer).props.title, '正在润色提示词…', 'tooltip');
});

test('润色中再次点击不会重复请求', () => {
  const before = rpcCalls.length;
  const node = findNode(renderer.tree, buttonOf);
  assertEqual(typeof node.props.onClick, 'undefined', 'polishing 状态下没有 onClick');
  assertEqual(rpcCalls.length, before, '没有新的 RPC');
});

console.log('\n[5] 返回结果 → 状态 3：已润色（可撤销）');

await testAsync('成功返回后写回草稿并切换为撤销图标', async () => {
  pendingRpc.resolve({ ok: true, value: { text: POLISHED } });
  await flush();
  renderer.commit();
  assertEqual(button(renderer).props['data-state'], 'done', 'data-state');
  assertEqual(iconOf(renderer), 'undo', '图标切到撤销箭头');
  assertEqual(composer.state.draft, POLISHED, '草稿已被润色文本替换');
  assertEqual(button(renderer).props.title, '撤销润色，恢复原始输入', 'tooltip');
  assertEqual(button(renderer).props.disabled, false, '可点击');
});

test('done 图标就是导出的撤销路径（逐字符一致）', () => {
  const path = allNodes(renderer.tree).find((node) => node.type === 'path');
  assertEqual(String(path.props.d), clientExports.__internals.UNDO_PATH, '渲染的 d 必须等于常量');
});

console.log('\n[6] 点击撤销 → 回到状态 1（叶子 + 原文）');

test('撤销回退到润色前的原始草稿', () => {
  renderer.click(buttonOf);
  assertEqual(composer.state.draft, ORIGINAL, '草稿恢复为原文');
  assertEqual(button(renderer).props['data-state'], 'idle', 'data-state');
  assertEqual(iconOf(renderer), 'leaf', '图标回到叶子');
});

await testAsync('撤销后可以再次润色（requestId 单调递增）', async () => {
  rpcCalls = [];
  renderer.click(buttonOf);
  assertEqual(button(renderer).props['data-state'], 'polishing', '再次进入润色中');
  pendingRpc.resolve({ ok: true, value: { text: `${POLISHED}（第二版）` } });
  await flush();
  renderer.commit();
  assertEqual(button(renderer).props['data-state'], 'done', '第二次也进入已润色');
  assertEqual(composer.state.draft, `${POLISHED}（第二版）`, '第二次结果写回');
  renderer.click(buttonOf);
  assertEqual(composer.state.draft, ORIGINAL, '第二次撤销回到原文');
});

/* -------------------------------------------------------------------------- */
/* 7. Bug 修复：草稿漂移后不再停留在「撤销」状态                                */
/* -------------------------------------------------------------------------- */

console.log('\n[7] Bug 修复：删除 / 改写后图标不再停留在撤销态');

/** 润色一次并进入 done 态，返回全套句柄。 */
async function polishedComposer(make) {
  const c = make();
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 'bug' }, facade);
  r.click(buttonOf);
  pendingRpc.resolve({ ok: true, value: { text: POLISHED } });
  await flush();
  r.commit();
  return { c, r };
}

await testAsync('润色完成后把句子删掉 → 图标回到叶子（原 bug 现场）', async () => {
  const { c, r } = await polishedComposer(() => makeComposer());
  assertEqual(iconOf(r), 'undo', '前置：处于撤销态');
  c.inputActions.setDraft('');
  r.forceRender();
  assertEqual(button(r).props['data-state'], 'idle', 'data-state 回到 idle');
  assertEqual(iconOf(r), 'leaf', '图标回到叶子');
  assertEqual(button(r).props.disabled, true, '空草稿时按钮禁用');
});

await testAsync('逐字删除润色结果 → 每一步都立刻回到叶子', async () => {
  const { c, r } = await polishedComposer(() => makeComposer());
  for (let length = POLISHED.length - 1; length >= 0; length -= 1) {
    c.inputActions.setDraft(POLISHED.slice(0, length));
    r.forceRender();
    assertEqual(button(r).props['data-state'], 'idle', `删到 ${length} 字时应为 idle`);
    assertEqual(iconOf(r), 'leaf', `删到 ${length} 字时图标应为叶子`);
  }
});

await testAsync('改写润色结果（保留原文 + 自己补一句）→ 回到叶子且不覆盖用户输入', async () => {
  const { c, r } = await polishedComposer(() => makeComposer());
  c.inputActions.setDraft(`${POLISHED}\n再补充一条：只统计 2024 年之后的数据`);
  r.forceRender();
  assertEqual(button(r).props['data-state'], 'idle', 'data-state');
  assertEqual(iconOf(r), 'leaf', '图标');
  assertEqual(c.state.draft.endsWith('2024 年之后的数据'), true, '用户输入保持原样');
});

await testAsync('写回尚未落地时不会误清撤销入口', async () => {
  const c = makeLazyComposer();
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 'lazy' }, facade);
  r.click(buttonOf);
  pendingRpc.resolve({ ok: true, value: { text: POLISHED } });
  await flush();
  r.commit();
  assertEqual(button(r).props['data-state'], 'done', '写回未落地时仍是 done');
  assertEqual(iconOf(r), 'undo', '仍是撤销图标');
  c.applyWrite();
  r.forceRender();
  assertEqual(button(r).props['data-state'], 'done', '写回落地后仍是 done');
  c.type('');
  r.forceRender();
  assertEqual(button(r).props['data-state'], 'idle', '删除后回到 idle');
});

await testAsync('编辑器规范化了写回文本（草稿 ≠ 模型输出）→ 仍保持可撤销', async () => {
  const { c, r } = await polishedComposer(() => makeComposer(ORIGINAL, (text) => text.replace(/\n+/gu, ' ').trim()));
  assertEqual(button(r).props['data-state'], 'done', '规范化后仍是 done');
  assertEqual(iconOf(r), 'undo', '仍是撤销图标');
  c.inputActions.setDraft('');
  r.forceRender();
  assertEqual(iconOf(r), 'leaf', '删除后回到叶子');
});

await testAsync('模型原样返回（写回是空操作）→ done，删除后仍能回到叶子', async () => {
  const c = makeComposer();
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 'same' }, facade);
  r.click(buttonOf);
  pendingRpc.resolve({ ok: true, value: { text: ORIGINAL } });
  await flush();
  r.commit();
  assertEqual(button(r).props['data-state'], 'done', '原样返回也进入 done');
  c.inputActions.setDraft('');
  r.forceRender();
  assertEqual(iconOf(r), 'leaf', '删除后回到叶子');
});

await testAsync('漂移复位后仍可再次润色，且撤销回到本轮原文', async () => {
  const { c, r } = await polishedComposer(() => makeComposer());
  c.inputActions.setDraft('');
  r.forceRender();
  c.inputActions.setDraft('第二轮的草稿');
  r.forceRender();
  r.click(buttonOf);
  assertEqual(button(r).props['data-state'], 'polishing', '第二轮可以再润色');
  pendingRpc.resolve({ ok: true, value: { text: '第二轮润色结果' } });
  await flush();
  r.commit();
  assertEqual(c.state.draft, '第二轮润色结果', '写回');
  assertEqual(iconOf(r), 'undo', '第二轮也是撤销态');
  r.click(buttonOf);
  assertEqual(c.state.draft, '第二轮的草稿', '撤销回到第二轮原文，而不是第一轮');
});

await testAsync('done 态下把草稿改回原文 → 同样回到叶子（撤销已无意义）', async () => {
  const { c, r } = await polishedComposer(() => makeComposer());
  c.inputActions.setDraft(ORIGINAL);
  r.forceRender();
  assertEqual(button(r).props['data-state'], 'idle', 'data-state');
  assertEqual(iconOf(r), 'leaf', '图标');
});

/* -------------------------------------------------------------------------- */
/* 8. 异常与边界                                                               */
/* -------------------------------------------------------------------------- */

console.log('\n[8] 异常与边界');

await testAsync('Host 返回失败：不覆盖草稿，提示错误', async () => {
  const c = makeComposer();
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 's2' }, facade);
  r.click(buttonOf);
  pendingRpc.resolve({ ok: false, error: { code: 'timeout', message: '模型超时', details: {} } });
  await flush();
  r.commit();
  assertEqual(c.state.draft, ORIGINAL, '草稿未被改写');
  assertEqual(button(r).props['data-state'], 'idle', '回到未润色');
  assertEqual(button(r).props.title, '模型超时', 'tooltip 展示 Host 错误');
  assertEqual(button(r).props['data-notice'], 'error', '错误样式标记');
});

await testAsync('润色期间用户改了草稿：丢弃结果，不覆盖用户输入', async () => {
  const c = makeComposer();
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 's3' }, facade);
  r.click(buttonOf);
  c.inputActions.setDraft('我自己又加了一句');
  pendingRpc.resolve({ ok: true, value: { text: POLISHED } });
  await flush();
  r.commit();
  assertEqual(c.state.draft, '我自己又加了一句', '用户输入被保留');
  assertEqual(button(r).props['data-state'], 'idle', '回到未润色');
  assertEqual(button(r).props['data-notice'], 'warn', '警告样式标记');
  assertEqual(button(r).props.title, '润色期间草稿被修改，本次结果已丢弃', '提示文案');
});

test('空草稿：不请求宿主，只提示', () => {
  const c = makeComposer('   ');
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 's4' }, facade);
  assertEqual(button(r).props.disabled, true, '空草稿时按钮禁用');
  assertEqual(button(r).props.title, '先输入一点内容，再点叶子图标润色', '空草稿提示');
  const before = rpcCalls.length;
  findNode(r.tree, buttonOf).props.onClick({});
  r.commit();
  assertEqual(rpcCalls.length, before, '没有发出 RPC');
  assertEqual(c.state.draft, '   ', '草稿不变');
});

test('提交中（submitting）时按钮锁定', () => {
  const c = makeComposer();
  c.state.phase = 'submitting';
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 's5' }, facade);
  assertEqual(button(r).props.disabled, true, 'locked');
  c.state.phase = 'plain';
  r.forceRender();
  assertEqual(button(r).props.disabled, false, '恢复可点击');
});

test('没有 Session（useInput 返回 undefined）时不渲染', () => {
  const r = mount(registeredComponent, { useInput: () => undefined, inputActions: {}, sessionId: undefined }, facade);
  assertEqual(r.tree, null, '渲染 null');
});

await testAsync('缺少 connection 服务时给出可读错误而不是崩溃', async () => {
  clientExports.__internals.setContext({ get: () => undefined });
  try {
    const c = makeComposer();
    const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 's6' }, facade);
    r.click(buttonOf);
    await flush();
    r.commit();
    assertEqual(button(r).props.title, '暂时连不上 DSH Host，无法润色', '离线提示');
    assertEqual(c.state.draft, ORIGINAL, '草稿不变');
  } finally {
    // 必须还原，否则后续用例会拿到「没有 connection」的假上下文。
    clientExports.__internals.setContext(ctx);
  }
});

/* -------------------------------------------------------------------------- */
/* 9. 纯状态机（不依赖渲染）                                                    */
/* -------------------------------------------------------------------------- */

console.log('\n[9] 纯状态机（不依赖渲染）');

const { reduce, actionOf, iconKindOf, INITIAL } = clientExports.__internals;

test('reduce: 请求 / 成功 / 观测 / 撤销 的完整链路', () => {
  const a = reduce(INITIAL, { type: 'request', draft: 'x' });
  assertEqual(a.status, 'polishing', 'polishing');
  assertEqual(a.original, 'x', '记录原文');
  const b = reduce(a, { type: 'settle', requestId: a.requestId, text: 'X!', draft: 'x' });
  assertEqual(b.status, 'done', 'done');
  assertEqual(b.baseline, null, '写回还没观测到');
  assertEqual(reduce(b, { type: 'sync', draft: 'x' }), b, '草稿仍是原文 → 继续等待，不误清');
  const adopted = reduce(b, { type: 'sync', draft: 'X!' });
  assertEqual(adopted.baseline, 'X!', '观测到的草稿成为锚点');
  assertEqual(adopted.status, 'done', '仍是可撤销');
  const drifted = reduce(adopted, { type: 'sync', draft: '' });
  assertEqual(drifted.status, 'idle', '草稿漂移 → 回到未润色');
  assertEqual(drifted.original, '', '快照清空');
  assertEqual(reduce(b, { type: 'undo' }).status, 'idle', 'undo 仍然可用');
});

test('reduce: 模型原样返回时锚点当场就是原文', () => {
  const a = reduce(INITIAL, { type: 'request', draft: 'x' });
  const b = reduce(a, { type: 'settle', requestId: a.requestId, text: 'x', draft: 'x' });
  assertEqual(b.status, 'done', 'done');
  assertEqual(b.baseline, 'x', '锚点已就位');
  assertEqual(reduce(b, { type: 'sync', draft: '' }).status, 'idle', '删除后立即复位');
});

test('reduce: 过期响应与草稿变动都不会覆盖状态', () => {
  const a = reduce(INITIAL, { type: 'request', draft: 'x' });
  assertEqual(reduce(a, { type: 'settle', requestId: a.requestId + 9, text: 'stale', draft: 'x' }), a, '过期 requestId 被忽略');
  const changed = reduce(a, { type: 'settle', requestId: a.requestId, text: 'X!', draft: 'x+1' });
  assertEqual(changed.status, 'idle', '草稿变动 → 退回未润色');
  assertEqual(changed.polished, '', '不保留润色文本');
  assertEqual(changed.notice, 'changed', '给出提示');
});

test('reduce: idle / polishing 态下的 sync 是空操作', () => {
  assertEqual(reduce(INITIAL, { type: 'sync', draft: 'whatever' }), INITIAL, 'idle 不关心草稿');
  const polishing = reduce(INITIAL, { type: 'request', draft: 'x' });
  assertEqual(reduce(polishing, { type: 'sync', draft: '' }), polishing, 'polishing 不关心草稿');
});

test('actionOf / iconKindOf 三态映射', () => {
  assertEqual(actionOf('idle'), 'polish', 'idle → 润色');
  assertEqual(actionOf('polishing'), 'none', 'polishing → 无动作');
  assertEqual(actionOf('done'), 'undo', 'done → 撤销');
  assertEqual(iconKindOf('idle'), 'leaf', 'idle → 叶子');
  assertEqual(iconKindOf('polishing'), 'spinner', 'polishing → 进度环');
  assertEqual(iconKindOf('done'), 'undo', 'done → 撤销箭头');
});

/* -------------------------------------------------------------------------- */
/* 10. 展示层兜底：绝不把「要求澄清」写回输入框                                 */
/* -------------------------------------------------------------------------- */

console.log('\n[10] 展示层兜底：绝不把「要求澄清」写回输入框');

/** 你复现时贴回来的那段错误输出，以及正确的改写目标。 */
const REPORTED_DRAFT = '它是怎么样工作的';
const REPORTED_BAD =
  '请讲解「它」的工作原理，把「它」所指的对象讲清楚。若「它」指代的对象未提供或无法确定，请先向我确认具体是哪一个对象，再对该对象的工作原理进行讲解。';

test('scrubPolish 剔除澄清句、保留可用改写', () => {
  assertEqual(clientExports.__internals.isClarifySentence(REPORTED_BAD, REPORTED_DRAFT), true, '整段被判为澄清');
  assertEqual(
    clientExports.__internals.scrubPolish(REPORTED_BAD, REPORTED_DRAFT),
    '请讲解「它」的工作原理，把「它」所指的对象讲清楚。',
    '保留下来的改写内容',
  );
  assertEqual(clientExports.__internals.scrubPolish('请问你指的是哪一段文字？', REPORTED_DRAFT), null, '纯反问 → 不可用');
  assertEqual(
    clientExports.__internals.scrubPolish('请在交付前向我确认需求范围', '请在交付前向我确认需求范围'),
    '请在交付前向我确认需求范围',
    '草稿自带的措辞不误伤',
  );
  assertEqual(clientExports.__internals.scrubPolish('## 目标\n请讲解它的工作原理。', REPORTED_DRAFT), '## 目标\n请讲解它的工作原理。', '正常改写原样通过');
});

await testAsync('Host 返回带澄清句的结果 → 自动剔除后写回，输入框里没有反问', async () => {
  const c = makeComposer(REPORTED_DRAFT);
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 'scrub' }, facade);
  r.click(buttonOf);
  pendingRpc.resolve({ ok: true, value: { text: REPORTED_BAD } });
  await flush();
  r.commit();
  assertEqual(
    button(r).props['data-state'],
    'done',
    `仍然进入已润色（notice=${button(r).props['data-notice']} title=${button(r).props.title} draft=${JSON.stringify(c.state.draft)}）`,
  );
  assert(!c.state.draft.includes('请先向我确认'), '草稿里没有澄清句');
  assertEqual(c.state.draft, '请讲解「它」的工作原理，把「它」所指的对象讲清楚。', '写回剩下可用的改写');
});

await testAsync('Host 只返回反问 → 当作失败，草稿原封不动', async () => {
  const c = makeComposer(REPORTED_DRAFT);
  const r = mount(registeredComponent, { useInput: c.useInput, inputActions: c.inputActions, sessionId: 'pure' }, facade);
  r.click(buttonOf);
  pendingRpc.resolve({ ok: true, value: { text: '请问你指的是哪一段文字？' } });
  await flush();
  r.commit();
  assertEqual(button(r).props['data-state'], 'idle', '回到未润色');
  assertEqual(c.state.draft, REPORTED_DRAFT, '草稿不变');
  assertEqual(button(r).props.title, '模型的输出是在要求你补充信息，已丢弃；请重试或把草稿写得更具体', 'tooltip 说明原因');
  assertEqual(button(r).props['data-notice'], 'error', '错误样式');
});

/* -------------------------------------------------------------------------- */

console.log(`\nClient 半：${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
