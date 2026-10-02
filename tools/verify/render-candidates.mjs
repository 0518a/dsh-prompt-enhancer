/**
 * 图标候选稿渲染：把若干条候选路径渲染成对照图，用于肉眼挑选。
 * 只用于设计迭代，不参与质检（质检用 test-icon.mjs）。
 *
 * 运行：node tools/verify/render-candidates.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parsePath, sampleSubpath } from './svg-path.mjs';

const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url));

/** 四角闪耀（填充）：控制点贴近中心形成内凹边。 */
function sparkle(cx, cy, r) {
  const c = 0.28;
  return `M${cx} ${cy - r}Q${cx + c} ${cy - c} ${cx + r} ${cy}Q${cx + c} ${cy + c} ${cx} ${cy + r}Q${cx - c} ${cy + c} ${cx - r} ${cy}Q${cx - c} ${cy - c} ${cx} ${cy - r}Z`;
}

/**
 * 候选叶子：`stroke` 为描边路径，`fill` 为填充子路径（闪耀）。
 * 全部使用绝对坐标、1 位小数以内。
 */
const CANDIDATES = {
  'k-wide': {
    label: 'K 宽叶身 + 折角外突',
    stroke: 'M7.8 20.8C4.4 17.2 5.4 11.2 9.6 7.8C12.4 5.6 15.8 4.2 19.8 4.4C18.8 9 16.4 12.4 13.2 14.8L16.6 12.6C14.4 16.2 11 19 7.8 20.8Z',
    fill: sparkle(5, 5.4, 2.6),
  },
  'l-plump': {
    label: 'L 更饱满的叶身',
    stroke: 'M7.4 20.6C4 17 5.2 10.6 9.8 7.4C12.6 5.4 16 4.2 19.8 4.6C18.6 9.4 16 12.8 12.6 15L16.2 12.8C14 16.4 10.6 18.8 7.4 20.6Z',
    fill: sparkle(4.8, 5.2, 2.7),
  },
  'm-long': {
    label: 'M 更长叶身 + 折角',
    stroke: 'M8.6 21C4.6 17.4 5.8 11 10.2 7.6C13 5.4 16.4 4 20.2 4.2C19.2 8.8 16.8 12.4 13.4 14.8L17 12.6C14.6 16.4 11.8 19 8.6 21Z',
    fill: sparkle(5.4, 5.2, 2.5),
  },
  'n-soft': {
    label: 'N 宽叶身 + 圆润折浪',
    stroke: 'M7.8 20.8C4.4 17.2 5.4 11.2 9.6 7.8C12.4 5.6 15.8 4.2 19.8 4.4C18.6 8.8 16.4 12.2 13.6 14.6C15.4 13.6 16.2 13 16.6 12.4C14.2 16.2 11 19 7.8 20.8Z',
    fill: sparkle(5, 5.4, 2.6),
  },
  'o-stem': {
    label: 'O 宽叶身 + 长茎收尾',
    stroke: 'M8.4 21.4C4.6 17.6 5.6 11.2 10 7.8C12.8 5.6 16.2 4.2 20 4.4C19 9 16.6 12.4 13.4 14.8L16.8 12.6C14.6 16.4 11.6 19.4 8.4 21.4Z',
    fill: sparkle(5.2, 5.2, 2.6),
  },
};

const icons = {};
for (const [key, candidate] of Object.entries(CANDIDATES)) {
  const shapes = [
    { kind: 'stroke', points: sampleSubpath(parsePath(candidate.stroke).subpaths[0]), width: 2, opacity: 1 },
  ];
  for (const subpath of parsePath(candidate.fill).subpaths) {
    shapes.push({ kind: 'fill', subpaths: [sampleSubpath(subpath)] });
  }
  icons[key] = { label: candidate.label, shapes };
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'candidates.json'), JSON.stringify({ viewBox: 24, icons }, null, 0));
console.log(`wrote ${join(OUT_DIR, 'candidates.json')} (${Object.keys(icons).length} candidates)`);
