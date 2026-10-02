/**
 * 把三个图标形状导出成几何 JSON，交给 rasterize.py 光栅化成预览图。
 * 这样预览与运行时用的是**同一份路径数据**（从 lib/client/index.js 读取）。
 *
 * 运行：node tools/verify/render-icon.mjs [输出目录]
 */

import vm from 'node:vm';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeDocument, createReactFacade } from './harness.mjs';
import { parsePath, sampleSubpath } from './svg-path.mjs';

const CLIENT_PATH = fileURLToPath(new URL('../../lib/client/index.js', import.meta.url));
const OUT_DIR = process.argv[2] ?? fileURLToPath(new URL('./out/', import.meta.url));

globalThis.window = { __ModuleLoader__: { load() {} } };
globalThis.document = createFakeDocument();
let registration;
globalThis.window.__ModuleLoader__.load = (entry) => {
  registration = entry;
};
vm.runInThisContext(readFileSync(CLIENT_PATH, 'utf8'), { filename: CLIENT_PATH });
const { LEAF_STAR_PATH, UNDO_PATH, RING_RADIUS, RING_ARC } = registration.factory(() => createReactFacade()).__internals;

/** 把 24 视框坐标取整到 0.001，减小 JSON 体积。 */
const round = (points) => points.map(({ x, y }) => ({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) }));

/** 圆环采样：SVG 的 circle 从 3 点钟方向顺时针。 */
function arcPoints(cx, cy, r, startDeg, endDeg) {
  const points = [];
  for (let step = 0; step <= 64; step += 1) {
    const angle = ((startDeg + ((endDeg - startDeg) * step) / 64) * Math.PI) / 180;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

const leafStarPath = parsePath(LEAF_STAR_PATH);
const undoPath = parsePath(UNDO_PATH);
const [arcLength] = RING_ARC.split(' ').map(Number);
const arcDegrees = (arcLength / (2 * Math.PI * RING_RADIUS)) * 360;

const icons = {
  leaf: {
    label: 'idle · leaf + sparkle (evenodd)',
    shapes: [
      { kind: 'fill', rule: 'evenodd', subpaths: leafStarPath.subpaths.map((subpath) => round(sampleSubpath(subpath))) },
    ],
  },
  spinner: {
    label: 'polishing · progress ring',
    shapes: [
      { kind: 'stroke', points: round(arcPoints(12, 12, RING_RADIUS, 0, 360)), width: 2.2, opacity: 0.22 },
      { kind: 'stroke', points: round(arcPoints(12, 12, RING_RADIUS, 0, arcDegrees)), width: 2.2, opacity: 1 },
    ],
  },
  undo: {
    label: 'done · undo arrow',
    shapes: [
      { kind: 'stroke', points: round(sampleSubpath(undoPath.subpaths[0])), width: 2, opacity: 1 },
      { kind: 'stroke', points: round(sampleSubpath(undoPath.subpaths[1])), width: 2, opacity: 1 },
    ],
  },
};

mkdirSync(dirname(join(OUT_DIR, 'icons.json')), { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'icons.json'), JSON.stringify({ viewBox: 24, icons }, null, 0));
console.log(`wrote ${join(OUT_DIR, 'icons.json')}`);
console.log(
  Object.entries(icons)
    .map(([name, icon]) => {
      const shapes = icon.shapes.map((shape) => `${shape.kind}(${shape.subpaths ? shape.subpaths.flat().length : shape.points.length}pts)`).join(' + ');
      return `  ${name}: ${shapes}`;
    })
    .join('\n'),
);
