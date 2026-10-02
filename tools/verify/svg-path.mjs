/**
 * 极简 SVG 路径工具：只覆盖本插件用到的绝对命令（M/L/H/V/C/Q/A/Z）。
 * 供图标质检与离线渲染共用，避免两份实现漂移。
 */

/** 每个命令的参数个数。 */
export const ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, A: 7, Z: 0 };

/** 隐式重复命令：M 之后的裸坐标等价于 L，其余沿用上一条命令。 */
function repeatCommand(previous, token) {
  return String(token).match(/[A-Za-z]/u) ? String(token) : previous === 'M' ? 'L' : previous;
}

/**
 * 把路径串解析成命令与子路径。
 * @param {string} d - 路径数据。
 * @returns {{commands: Array<{cmd: string, args: number[]}>, subpaths: Array<Array<{cmd: string, args: number[]}>>, numbers: number[]}}
 */
export function parsePath(d) {
  const tokens = d.match(/[MLHVCQAZmlhvcqaz]|-?\d*\.?\d+/gu) ?? [];
  const commands = [];
  const subpaths = [];
  let current = null;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    let cmd = /[A-Za-z]/u.test(token) ? token : null;
    if (cmd !== null) index += 1;
    else if (commands.length === 0) throw new Error(`路径必须以命令开头，遇到 ${token}`);
    else cmd = repeatCommand(commands[commands.length - 1].cmd, token);
    if (cmd !== cmd.toUpperCase()) throw new Error(`只允许绝对命令，遇到 ${cmd}`);
    if (!(cmd in ARG_COUNT)) throw new Error(`不支持的命令 ${cmd}`);
    const argc = ARG_COUNT[cmd];
    const args = tokens.slice(index, index + argc).map(Number);
    if (args.length !== argc || args.some((value) => !Number.isFinite(value))) throw new Error(`${cmd} 参数不足或非法`);
    index += argc;
    const entry = { cmd, args };
    commands.push(entry);
    if (cmd === 'M') {
      current = [entry];
      subpaths.push(current);
    } else {
      if (current === null) throw new Error('子路径必须在 M 之后');
      current.push(entry);
    }
  }
  const numbers = tokens.map(Number).filter((value) => Number.isFinite(value));
  return { commands, subpaths, numbers };
}

/** 采样步数：贝塞尔 16 段、圆弧 24 段，足够做几何质检与预览。 */
const CURVE_STEPS = 16;
const ARC_STEPS = 24;

/**
 * 把一个子路径采样成多边形顶点（闭合由调用方隐含处理）。
 * @param {Array<{cmd: string, args: number[]}>} subpath - 子路径命令。
 * @returns {Array<{x: number, y: number}>} 采样点。
 */
export function sampleSubpath(subpath) {
  const points = [];
  let cx = 0;
  let cy = 0;
  const push = (x, y) => {
    points.push({ x, y });
    cx = x;
    cy = y;
  };
  for (const { cmd, args } of subpath) {
    if (cmd === 'M' || cmd === 'L') push(args[0], args[1]);
    else if (cmd === 'H') push(args[0], cy);
    else if (cmd === 'V') push(cx, args[0]);
    else if (cmd === 'C') {
      // 三次贝塞尔必须以**曲线起点**为原点求值：push 会移动 cx/cy，
      // 所以先把起点固定下来，否则每一步都从上一个采样点出发，曲线会外扩。
      const x0 = cx;
      const y0 = cy;
      for (let step = 1; step <= CURVE_STEPS; step += 1) {
        const t = step / CURVE_STEPS;
        const u = 1 - t;
        push(
          u * u * u * x0 + 3 * u * u * t * args[0] + 3 * u * t * t * args[2] + t * t * t * args[4],
          u * u * u * y0 + 3 * u * u * t * args[1] + 3 * u * t * t * args[3] + t * t * t * args[5],
        );
      }
    } else if (cmd === 'Q') {
      const x0 = cx;
      const y0 = cy;
      for (let step = 1; step <= CURVE_STEPS; step += 1) {
        const t = step / CURVE_STEPS;
        const u = 1 - t;
        push(u * u * x0 + 2 * u * t * args[0] + t * t * args[2], u * u * y0 + 2 * u * t * args[1] + t * t * args[3]);
      }
    } else if (cmd === 'A') {
      const [rx, ry, , largeArc, sweep, x, y] = args;
      const dx = (cx - x) / 2;
      const dy = (cy - y) / 2;
      const lambda = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
      if (lambda > 1.0001) throw new Error(`圆弧半径 ${rx} 小于弦长的一半（SVG 会自动放大，视为设计瑕疵）`);
      const sign = largeArc === sweep ? -1 : 1;
      const coefficient =
        sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * dy * dy - ry * ry * dx * dx) / (rx * rx * dy * dy + ry * ry * dx * dx)));
      const ccx = coefficient * ((rx * dy) / ry) + (cx + x) / 2;
      const ccy = coefficient * (-(ry * dx) / rx) + (cy + y) / 2;
      const start = Math.atan2((cy - ccy) / ry, (cx - ccx) / rx);
      let end = Math.atan2((y - ccy) / ry, (x - ccx) / rx);
      if (sweep === 1 && end < start) end += Math.PI * 2;
      if (sweep === 0 && end > start) end -= Math.PI * 2;
      const span = end - start;
      if (Math.abs(rx - ry) > 1e-6) throw new Error('只支持正圆弧');
      const mid = start + span / 2;
      const radius = Math.hypot(rx * Math.cos(mid), ry * Math.sin(mid));
      if (Math.abs(radius - rx) > 0.02) throw new Error(`圆弧实际半径 ${radius.toFixed(3)} ≠ 声明半径 ${rx}`);
      for (let step = 1; step <= ARC_STEPS; step += 1) {
        const angle = start + (span * step) / ARC_STEPS;
        push(ccx + rx * Math.cos(angle), ccy + ry * Math.sin(angle));
      }
    } else if (cmd === 'Z') {
      // 闭合子路径：多边形隐式闭口，无需补点。
    } else {
      throw new Error(`采样未实现的命令 ${cmd}`);
    }
  }
  return points;
}

/**
 * 多边形有向面积（符号即绕向）。
 * @param {Array<{x: number, y: number}>} points - 顶点。
 * @returns {number} 有向面积。
 */
export function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * 采样点包围盒。
 * @param {Array<{x: number, y: number}>} points - 顶点。
 * @returns {{minX: number, maxX: number, minY: number, maxY: number}}
 */
export function bounds(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * 归一化到 0..1 单位坐标：把 24×24 视框里的点映射到目标画布尺寸。
 * @param {Array<{x: number, y: number}>} points - 24 视框坐标。
 * @param {number} size - 目标像素边长。
 * @returns {Array<{x: number, y: number}>} 像素坐标。
 */
export function scalePoints(points, size) {
  const factor = size / 24;
  return points.map((point) => ({ x: point.x * factor, y: point.y * factor }));
}
