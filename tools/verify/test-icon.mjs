/**
 * 图标资源验证：不渲染成位图，而是直接解析 `lib/client/index.js` 里的路径数据，
 * 做几何与工程层面的质检。
 *
 * idle 图标由用户提供的 `leaf_star_vector.svg` 归一化而来，结构是
 * **1 条路径 / 3 个子路径 / fill-rule=evenodd**：
 *   ① 叶身外轮廓 ② 叶身内轮廓（挖空 → 描边带观感）③ 左上方四角闪耀。
 * 因此这里重点校验这套 evenodd 结构成立的条件。
 *
 * 检查项：
 * 1. 语法与体积：只用绝对 M/L/Z、1 位小数、点数预算；
 * 2. 几何：所有坐标落在 24×24 可用区内、包围盒居中、光学尺寸与同族图标一致；
 * 3. evenodd 结构：内轮廓严格包含于外轮廓内、描边带厚落在合理区间、
 *    闪耀与叶身带互不接触（否则 evenodd 会把重叠处挖成洞）；
 * 4. 进度环：dash 之和等于周长、亮弧占比合理、外径与叶身宽度相当。
 *
 * 运行：node tools/verify/test-icon.mjs
 */

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, createFakeDocument, createReactFacade } from './harness.mjs';
import { bounds, parsePath, sampleSubpath, signedArea } from './svg-path.mjs';

const CLIENT_PATH = fileURLToPath(new URL('../../lib/client/index.js', import.meta.url));

globalThis.window = { __ModuleLoader__: { load() {} } };
globalThis.document = createFakeDocument();
let registration;
globalThis.window.__ModuleLoader__.load = (entry) => {
  registration = entry;
};
vm.runInThisContext(readFileSync(CLIENT_PATH, 'utf8'), { filename: CLIENT_PATH });
const exports_ = registration.factory(() => createReactFacade());
const { LEAF_STAR_PATH, UNDO_PATH, RING_RADIUS, RING_ARC } = exports_.__internals;

let failures = 0;
let checks = 0;
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

/** 点到折线环的最近距离。 */
function distanceToRing(point, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    best = Math.min(best, distanceToSegment(point, ring[i], ring[(i + 1) % ring.length]));
  }
  return best;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** 射线法：点是否严格位于多边形内部。 */
function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

console.log('\n[1] 路径语法与体积');

const leafStar = parsePath(LEAF_STAR_PATH);
const undo = parsePath(UNDO_PATH);
const [outer, hole, sparkle] = leafStar.subpaths;

test('只用绝对命令（M + 隐式 L + Z）', () => {
  for (const path of [leafStar, undo]) {
    for (const cmd of path.commands.map((c) => c.cmd)) {
      assert('MLHVCQAZ'.includes(cmd), `出现多余命令 ${cmd}`);
      assertEqual(cmd, cmd.toUpperCase(), `只允许绝对命令，遇到 ${cmd}`);
    }
  }
  const kinds = new Set(leafStar.commands.map((c) => c.cmd));
  assert([...kinds].every((cmd) => cmd === 'M' || cmd === 'L' || cmd === 'Z'), `叶子只应使用 M/L/Z，实际 ${[...kinds].join(',')}`);
});

test('数值精度不超过 1 位小数', () => {
  for (const value of [...leafStar.numbers, ...undo.numbers]) {
    const decimals = String(value).split('.')[1] ?? '';
    assert(decimals.length <= 1, `${value} 的小数位超过 1`);
  }
  for (const d of [LEAF_STAR_PATH, UNDO_PATH]) {
    assert(!/\.\d\d/u.test(d), '路径里不应出现两位小数');
    assert(!/\d\.0(?=\D|$)/u.test(d), '不应出现多余的 .0');
  }
});

test('点数与体积预算（导入稿在预算内）', () => {
  const points = (subpath) => sampleSubpath(subpath).length;
  assertEqual(leafStar.subpaths.length, 3, '叶子应是 3 个子路径');
  assert(points(outer) <= 40 && points(hole) <= 24 && points(sparkle) <= 22, `点数 ${points(outer)}/${points(hole)}/${points(sparkle)}`);
  assert(LEAF_STAR_PATH.length <= 720, `叶子路径长度 ${LEAF_STAR_PATH.length}`);
  assert(undo.commands.length <= 7, `撤销命令数 ${undo.commands.length}`);
  assert(UNDO_PATH.length <= 80, `撤销路径长度 ${UNDO_PATH.length}`);
});

console.log('\n[2] 几何与光学尺寸');

test('所有坐标落在 24×24 视框内，且留有 ≥ 1.5 的边距', () => {
  const points = [...leafStar.subpaths, ...undo.subpaths].flatMap(sampleSubpath);
  const area = bounds(points);
  assert(area.minX >= 1.5 && area.maxX <= 22.5, `x 越界: ${area.minX.toFixed(2)}..${area.maxX.toFixed(2)}`);
  assert(area.minY >= 1.5 && area.maxY <= 22.5, `y 越界: ${area.minY.toFixed(2)}..${area.maxY.toFixed(2)}`);
});

test('叶子 + 闪耀的包围盒居中且光学尺寸与同族一致', () => {
  const area = bounds(leafStar.subpaths.flatMap(sampleSubpath));
  const width = area.maxX - area.minX;
  const height = area.maxY - area.minY;
  assert(width >= 15 && width <= 21, `宽度 ${width.toFixed(2)}`);
  assert(height >= 15 && height <= 21, `高度 ${height.toFixed(2)}`);
  const centerX = (area.minX + area.maxX) / 2;
  const centerY = (area.minY + area.maxY) / 2;
  assert(Math.abs(centerX - 12) <= 1, `水平中心 ${centerX.toFixed(2)} 偏离视框中心`);
  assert(Math.abs(centerY - 12) <= 1, `垂直中心 ${centerY.toFixed(2)} 偏离视框中心`);
});

test('撤销箭头的视觉尺寸与叶子相当（切换状态不跳动）', () => {
  const leafArea = bounds(leafStar.subpaths.flatMap(sampleSubpath));
  const undoArea = bounds(undo.subpaths.flatMap(sampleSubpath));
  const leafWidth = leafArea.maxX - leafArea.minX;
  const undoWidth = undoArea.maxX - undoArea.minX + 2;
  assert(Math.abs(undoWidth - leafWidth) <= 4, `宽度差 ${(undoWidth - leafWidth).toFixed(2)}`);
});

console.log('\n[3] evenodd 结构（挖空成立的前提）');

test('内轮廓严格位于外轮廓内部（否则挖空会破口）', () => {
  const outerPoints = sampleSubpath(outer);
  const holePoints = sampleSubpath(hole);
  for (const point of holePoints) assert(insideRing(point, outerPoints), `内轮廓点 (${point.x.toFixed(1)},${point.y.toFixed(1)}) 跑到外轮廓之外`);
});

test('描边带厚落在与进度环 / 撤销箭头同族的区间', () => {
  const outerPoints = sampleSubpath(outer);
  const distances = sampleSubpath(hole).map((point) => distanceToRing(point, outerPoints));
  const min = Math.min(...distances);
  const max = Math.max(...distances);
  assert(min >= 1.2, `最细处 ${min.toFixed(2)} 过细（16px 下会断线）`);
  assert(max <= 3.4, `最粗处 ${max.toFixed(2)} 过粗（会糊成一团）`);
});

test('闪耀与叶身带互不接触（否则 evenodd 会把重叠处挖成洞）', () => {
  const outerPoints = sampleSubpath(outer);
  const holePoints = sampleSubpath(hole);
  const sparklePoints = sampleSubpath(sparkle);
  for (const point of sparklePoints) {
    assert(!insideRing(point, outerPoints), `闪耀点 (${point.x.toFixed(1)},${point.y.toFixed(1)}) 落进叶身`);
  }
  const gapToOuter = Math.min(...sparklePoints.map((point) => distanceToRing(point, outerPoints)));
  const gapToHole = Math.min(...sparklePoints.map((point) => distanceToRing(point, holePoints)));
  assert(gapToOuter > 0.8, `闪耀与叶身外轮廓间距 ${gapToOuter.toFixed(2)} 过小`);
  assert(gapToHole > 0.8, `闪耀与叶身内轮廓间距 ${gapToHole.toFixed(2)} 过小`);
});

test('叶身外轮廓明显大于内轮廓与闪耀（层次正确）', () => {
  const outerArea = Math.abs(signedArea(sampleSubpath(outer)));
  const holeArea = Math.abs(signedArea(sampleSubpath(hole)));
  const sparkleArea = Math.abs(signedArea(sampleSubpath(sparkle)));
  assert(outerArea > holeArea * 2, `外轮廓面积 ${outerArea.toFixed(1)} 与内轮廓 ${holeArea.toFixed(1)} 差距不足`);
  assert(sparkleArea > 3 && sparkleArea < holeArea, `闪耀面积 ${sparkleArea.toFixed(1)} 与内轮廓 ${holeArea.toFixed(1)} 比例不合理`);
});

test('闪耀位于叶子的左上方', () => {
  const outerArea = bounds(sampleSubpath(outer));
  const sparkleArea = bounds(sampleSubpath(sparkle));
  assert(sparkleArea.maxY < outerArea.maxY - 5, '闪耀应在叶子之上');
  assert(sparkleArea.minX < outerArea.minX + 5, '闪耀应在叶子之左');
});

console.log('\n[4] 进度环');

test('轨道与亮弧共用半径，亮弧约占 1/4 圈且留出可见缺口', () => {
  const [arcLength, gap] = RING_ARC.split(' ').map(Number);
  const circumference = 2 * Math.PI * RING_RADIUS;
  assertEqual(RING_RADIUS, 8, '半径');
  assert(Math.abs(arcLength + gap - circumference) <= 0.5, `dash 之和 ${arcLength + gap} 应等于周长 ${circumference.toFixed(2)}`);
  const ratio = arcLength / circumference;
  assert(ratio > 0.2 && ratio < 0.35, `亮弧占比 ${(ratio * 100).toFixed(1)}% 不在合理区间`);
});

test('进度环外径与叶身宽度相当', () => {
  const leafArea = bounds(sampleSubpath(outer));
  const leafSpan = leafArea.maxX - leafArea.minX;
  const ringSpan = (RING_RADIUS + 1.1) * 2;
  assert(Math.abs(ringSpan - leafSpan) <= 4, `环外径 ${ringSpan} vs 叶身宽度 ${leafSpan.toFixed(2)}`);
});

/* -------------------------------------------------------------------------- */

console.log(`\n图标资源：${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
