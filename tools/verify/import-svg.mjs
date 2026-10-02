/**
 * 把用户提供的 leaf_star_vector.svg 归一化成 24×24 视框的图标，并导出候选稿供肉眼挑选。
 *
 * 处理链：解析（M/L/Z 绝对坐标）→ 求内容包围盒 → 等比缩放进 24×24 并居中
 *        → Douglas-Peucker 简化（闭合环）→ 1 位小数取整 → 省略隐式 L 命令。
 *
 * 运行：node tools/verify/import-svg.mjs [源 svg]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SOURCE = process.argv[2] ?? 'leaf_star_vector.svg';
const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url));

/** 最终采用的容差（24 视框单位）。 */
const FINAL_TOLERANCE = 0.08;
/** 内容在 24 视框里的目标最长边（与进度环 / 撤销箭头的光学尺寸对齐）。 */
const TARGET_SIZE = 18.8;

const svg = readFileSync(SOURCE, 'utf8');
const dAttribute = /d="([^"]+)"/u.exec(svg)?.[1];
if (dAttribute === undefined) throw new Error('源文件里没有 path d');
const fillRule = /fill-rule="([^"]+)"/u.exec(svg)?.[1] ?? 'nonzero';

/** 解析成子路径数组（本文件只用 M/L/Z 绝对坐标）。 */
function parseSubpaths(d) {
  const tokens = d.match(/[MLZmlz]|-?\d+(?:\.\d+)?/gu) ?? [];
  const subpaths = [];
  let current = [];
  let index = 0;
  let command = null;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/[A-Za-z]/u.test(token)) {
      command = token;
      index += 1;
      if (command.toUpperCase() === 'Z' && current.length > 0) {
        subpaths.push(current);
        current = [];
      }
      continue;
    }
    if (command?.toUpperCase() !== 'M' && command?.toUpperCase() !== 'L') throw new Error(`不支持的源命令 ${command}`);
    current.push({ x: Number(tokens[index]), y: Number(tokens[index + 1]) });
    index += 2;
  }
  if (current.length > 0) subpaths.push(current);
  return subpaths;
}

/** 点到线段的距离。 */
function perpendicular(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Douglas-Peucker（闭合环按“首点=末点”处理）。 */
function simplify(points, tolerance) {
  if (points.length <= 3) return points;
  const ring = [...points, points[0]];
  const keep = new Set([0, ring.length - 1]);
  const stack = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDistance = 0;
    let farthest = -1;
    for (let i = start + 1; i < end; i += 1) {
      const distance = perpendicular(ring[i], ring[start], ring[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        farthest = i;
      }
    }
    if (maxDistance > tolerance && farthest !== -1) {
      keep.add(farthest);
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return [...keep].sort((a, b) => a - b).slice(0, -1).map((i) => ring[i]);
}

/** 朝质心缩放（用于把「描边带」加粗：内轮廓整体收缩一点）。 */
function shrinkTowardCentroid(points, factor) {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return points.map((p) => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}

const round1 = (value) => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};
/** 紧凑序列化：只写一个 M，后续坐标是隐式 L。 */
const serialize = (subpaths) => subpaths.map((points) => 'M' + points.map((p) => `${round1(p.x)} ${round1(p.y)}`).join(' ')).join('') + 'Z';

const rawSubpaths = parseSubpaths(dAttribute);
const all = rawSubpaths.flat();
const minX = Math.min(...all.map((p) => p.x));
const maxX = Math.max(...all.map((p) => p.x));
const minY = Math.min(...all.map((p) => p.y));
const maxY = Math.max(...all.map((p) => p.y));
const scale = TARGET_SIZE / Math.max(maxX - minX, maxY - minY);
const offsetX = 12 - ((minX + maxX) / 2) * scale;
const offsetY = 12 - ((minY + maxY) / 2) * scale;

// 子路径 0 = 叶身外轮廓、1 = 叶身内轮廓（挖空）、2 = 闪耀
const toBox = (subpath, tolerance, holeFactor = 1) => {
  const scaled = subpath.map((p) => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY }));
  const adjusted = holeFactor === 1 ? scaled : shrinkTowardCentroid(scaled, holeFactor);
  return simplify(adjusted, tolerance);
};

const build = (tolerance, holeFactor = 1) =>
  rawSubpaths.map((subpath, i) => toBox(subpath, tolerance, i === 1 ? holeFactor : 1));

const VARIANTS = {
  'leaf-star': { label: '导入稿（容差 0.08，忠实）', subpaths: build(0.08) },
  'leaf-star-fine': { label: '导入稿（容差 0.04，最细）', subpaths: build(0.04) },
  'leaf-star-loose': { label: '导入稿（容差 0.15，最简）', subpaths: build(0.15) },
  'leaf-star-thick': { label: '导入稿 + 内轮廓收缩 0.86（带更粗）', subpaths: build(0.08, 0.86) },
  'leaf-star-thick2': { label: '导入稿 + 内轮廓收缩 0.78（带最粗）', subpaths: build(0.08, 0.78) },
};

/** 点到多边形边界的最近距离。 */
function distanceToRing(point, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    best = Math.min(best, perpendicular(point, ring[i], ring[(i + 1) % ring.length]));
  }
  return best;
}

/** 环的「带厚」统计：内轮廓各点到外轮廓的最近距离。 */
function bandStats(outer, inner) {
  const distances = inner.map((point) => distanceToRing(point, outer));
  return {
    min: Math.min(...distances),
    max: Math.max(...distances),
    mean: distances.reduce((sum, value) => sum + value, 0) / distances.length,
  };
}

/** 点是否严格在多边形内部（射线法）。 */
function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const icons = {};
for (const [key, variant] of Object.entries(VARIANTS)) {
  icons[key] = { label: variant.label, shapes: [{ kind: 'fill', rule: fillRule, subpaths: variant.subpaths }] };
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'import.json'), JSON.stringify({ viewBox: 24, icons }, null, 0));

console.log('源包围盒 :', `${minX},${minY} → ${maxX},${maxY} (${maxX - minX} × ${maxY - minY})`);
console.log('缩放     :', scale.toFixed(6), '偏移', offsetX.toFixed(3), offsetY.toFixed(3), '填充规则', fillRule);
console.log('点数     :', VARIANTS['leaf-star'].subpaths.map((s) => s.length).join(' / '));
console.log('');

for (const [key, variant] of Object.entries(VARIANTS)) {
  const [outer, inner] = variant.subpaths;
  const band = bandStats(outer, inner);
  const contained = inner.every((point) => insideRing(point, outer));
  console.log(
    `${key.padEnd(17)} 带厚 ${band.min.toFixed(2)}~${band.max.toFixed(2)} (均值 ${band.mean.toFixed(2)})  内轮廓包含于外轮廓: ${contained}`,
  );
}
console.log('');

const finalSubpaths = VARIANTS['leaf-star'].subpaths;
const finalPath = serialize(finalSubpaths);
console.log(`最终路径（容差 ${FINAL_TOLERANCE}）：${finalPath.length} 字符，${finalSubpaths.reduce((n, s) => n + s.length, 0)} 个点`);
console.log(finalPath);
console.log('');
console.log('候选稿已写入 out/import.json（5 份，含不同容差与带厚）');
