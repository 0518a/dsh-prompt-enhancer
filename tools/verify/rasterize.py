"""
把 render-icon.mjs / render-candidates.mjs 导出的几何 JSON 光栅化成预览图。

- fill：nonzero 缠绕规则（正好验证「多子路径同向、并集无孔洞」）
- stroke：按到线段集合的距离场绘制圆头粗线
- 4× 超采样后缩小，得到接近浏览器抗锯齿的效果

用法：python rasterize.py [out_dir] [输入.json] [输出.png]
"""

import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "out")
SOURCE_NAME = sys.argv[2] if len(sys.argv) > 2 else "icons.json"
PREVIEW_NAME = sys.argv[3] if len(sys.argv) > 3 else "icon-preview.png"
SS = 4  # 超采样倍数


def load_icons():
    with open(os.path.join(OUT_DIR, SOURCE_NAME), "r", encoding="utf-8") as handle:
        return json.load(handle)


def winding_fill(subpaths, size, scale, rule="nonzero"):
    """在 size×size 像素上按 nonzero / evenodd 规则填充多个子路径。"""
    ys, xs = np.mgrid[0:size, 0:size]
    px = (xs + 0.5) / scale  # 24 视框坐标
    py = (ys + 0.5) / scale
    winding = np.zeros((size, size), dtype=np.int32)
    for points in subpaths:
        n = len(points)
        for i in range(n):
            x1, y1 = points[i]["x"], points[i]["y"]
            x2, y2 = points[(i + 1) % n]["x"], points[(i + 1) % n]["y"]
            if y1 == y2:
                continue
            # 标准缠绕数算法（对整幅图向量化）
            upward = (y1 <= py) & (py < y2)
            downward = (y2 <= py) & (py < y1)
            if upward.any() or downward.any():
                is_left = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1)
                winding += np.where(upward & (is_left > 0), 1, 0)
                winding -= np.where(downward & (is_left < 0), 1, 0)
    if rule == "evenodd":
        return (winding % 2) != 0
    return winding != 0


def stroke_mask(points, width, size, scale):
    """按点到线段的距离绘制圆头粗线（覆盖并集）。"""
    ys, xs = np.mgrid[0:size, 0:size]
    px = (xs + 0.5) / scale
    py = (ys + 0.5) / scale
    radius = width / 2
    covered = np.zeros((size, size), dtype=bool)
    for i in range(len(points) - 1):
        x1, y1 = points[i]["x"], points[i]["y"]
        x2, y2 = points[i + 1]["x"], points[i + 1]["y"]
        dx, dy = x2 - x1, y2 - y1
        length_sq = dx * dx + dy * dy
        if length_sq == 0:
            t = np.zeros_like(px)
        else:
            t = np.clip(((px - x1) * dx + (py - y1) * dy) / length_sq, 0, 1)
        cx = x1 + t * dx
        cy = y1 + t * dy
        covered |= (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius
    return covered


def render_icon(icon, size, color):
    """渲染一个图标为 RGBA 数组（已做超采样并缩小）。"""
    big = size * SS
    scale = big / 24.0
    coverage = np.zeros((big, big), dtype=np.float64)
    for shape in icon["shapes"]:
        if shape["kind"] == "fill":
            mask = winding_fill(shape["subpaths"], big, scale, shape.get("rule", "nonzero")).astype(np.float64)
        else:
            mask = stroke_mask(shape["points"], shape["width"], big, scale).astype(np.float64)
        coverage = 1 - (1 - coverage) * (1 - mask * shape.get("opacity", 1))
    # 缩小（盒式平均，模拟抗锯齿）
    small = coverage.reshape(size, SS, size, SS).mean(axis=(1, 3))
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[..., 0] = color[0]
    rgba[..., 1] = color[1]
    rgba[..., 2] = color[2]
    rgba[..., 3] = np.clip(small * 255, 0, 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def main():
    data = load_icons()
    icons = data["icons"]
    sizes = [16, 20, 24, 48]
    pad = 16
    cell_w = max(sizes) + pad * 2
    cell_h = max(sizes) + pad * 2
    rows = len(icons)
    cols = len(sizes)
    width = cols * cell_w
    height = rows * cell_h
    sheet = Image.new("RGBA", (width * 2, height), (18, 20, 26, 255))
    draw = ImageDraw.Draw(sheet)
    # 右半区改浅色背景，检查深色主题下的观感
    draw.rectangle([width, 0, width * 2, height], fill=(246, 247, 249, 255))

    for row, (name, icon) in enumerate(icons.items()):
        for col, size in enumerate(sizes):
            light = render_icon(icon, size, (255, 255, 255))
            dark = render_icon(icon, size, (28, 30, 36))
            for half, image in ((0, light), (1, dark)):
                ox = half * width + col * cell_w + (cell_w - size) // 2
                oy = row * cell_h + (cell_h - size) // 2
                sheet.alpha_composite(image, (ox, oy))

    path = os.path.join(OUT_DIR, PREVIEW_NAME)
    sheet.save(path)
    print(f"wrote {path} ({sheet.width}x{sheet.height})")
    print("行：" + " / ".join(icons.keys()) + "；列：16 / 20 / 24 / 48 px；左深色底、右浅色底")


if __name__ == "__main__":
    main()
