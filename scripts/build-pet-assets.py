#!/usr/bin/env python3
"""生成 TokenBuddy 桌面宠物的默认形象素材(黑白猫 TokenBuddy 围巾版)。

输入为 9 张 1024x1024 状态图(浅灰背景),路径见 SOURCES。

处理:
  1. 洪水填充从四角抠掉浅灰背景(角色轮廓是深色描边,边缘连通安全)
  2. 按 alpha>20 裁到内容包围盒(阈值与 src/pet/pet.js 的命中检测一致)
  3. 等比缩放进 CONTENT_BOX,避免不同姿势切换时宠物窗口抖动
  4. 贴到统一 512x512 透明画布、底部对齐并留出顶部空间给余额气泡

用法:
  python3 scripts/build-pet-assets.py

依赖 Pillow;只在需要重新生成素材时运行,不参与 npm 构建与运行。
"""

import os
import sys
from collections import deque
from PIL import Image

GEN_DIR = os.environ.get(
    "TOKENBUDDY_ASSET_SOURCE",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "pet-source"),
)
# 状态顺序与 src/pet/pet.js stateMap 一一对应:
# 01 余额正常 02 余额0 03 偏低 04 单击 05 刷新中 06 失败 07 拖动 08 未知 09 无限
SOURCES = {
    "01": GEN_DIR + "/20261005-193008-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
    "02": GEN_DIR + "/20261005-193131-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
    "03": GEN_DIR + "/20261005-193244-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
    "04": GEN_DIR + "/20261005-193348-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
    "05": GEN_DIR + "/20261005-193600-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
    "06": GEN_DIR + "/20261005-195020-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
    "07": GEN_DIR + "/20261005-195049-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
    "08": GEN_DIR + "/20261005-195125-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
    "09": GEN_DIR + "/20261005-200622-A-cute-cartoon-cat-mascot-flat-sticker-s.png",
}
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "pet")

CANVAS = 512
CONTENT_BOX = (480, 380)   # 内容最大宽高
BOTTOM_PAD = 12            # 内容底部留白
ALPHA_THRESHOLD = 20       # 与 src/pet/pet.js computeAlpha 命中阈值一致
BG_TOLERANCE = 26          # 与背景色的最大通道差


def is_bg(px, bg):
    return all(abs(px[i] - bg[i]) <= BG_TOLERANCE for i in range(3))


def remove_background(image: Image.Image) -> Image.Image:
    """从四角 BFS 洪水填充,把与背景色连通的区域置透明;角色描边不会误删。"""
    rgba = image.convert("RGBA")
    w, h = rgba.size
    pixels = rgba.load()
    corners = [pixels[0, 0], pixels[w - 1, 0], pixels[0, h - 1], pixels[w - 1, h - 1]]
    # 取四角里亮度中位的一角当参考背景色,避免某一角有阴影
    corners.sort(key=lambda c: c[0] + c[1] + c[2])
    bg = corners[len(corners) // 2][:3]

    visited = bytearray(w * h)
    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bg(pixels[x, y], bg) and not visited[y * w + x]:
                visited[y * w + x] = 1
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(pixels[x, y], bg) and not visited[y * w + x]:
                visited[y * w + x] = 1
                queue.append((x, y))
    while queue:
        cx, cy = queue.popleft()
        px = pixels[cx, cy]
        pixels[cx, cy] = (px[0], px[1], px[2], 0)
        for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx]:
                if is_bg(pixels[nx, ny], bg):
                    visited[ny * w + nx] = 1
                    queue.append((nx, ny))
    return rgba


def normalize(src_path: str, out_path: str) -> None:
    with Image.open(src_path) as opened:
        image = remove_background(opened)

    alpha = image.getchannel("A").point(lambda v: 255 if v > ALPHA_THRESHOLD else 0)
    bbox = alpha.getbbox()
    if bbox is None:
        raise SystemExit(f"{src_path}: 抠背景后内容为空,检查背景容差")

    cropped = image.crop(bbox)
    width, height = cropped.size
    scale = min(CONTENT_BOX[0] / width, CONTENT_BOX[1] / height)
    new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    resized = cropped.resize(new_size, Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    offset = ((CANVAS - new_size[0]) // 2, CANVAS - BOTTOM_PAD - new_size[1])
    canvas.alpha_composite(resized, offset)

    canvas.save(out_path, format="PNG", optimize=True)

    content_alpha = canvas.getchannel("A").point(lambda v: 255 if v > ALPHA_THRESHOLD else 0)
    final_bbox = content_alpha.getbbox()
    print(
        f"  {os.path.basename(out_path)}  内容 {bbox[2]-bbox[0]}x{bbox[3]-bbox[1]}"
        f" -> 缩放 {new_size[0]}x{new_size[1]} 位置 {final_bbox}"
        f"  {os.path.getsize(out_path) // 1024}KB"
    )


def main() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"生成到 {OUTPUT_DIR}")
    for name, src in SOURCES.items():
        if not os.path.exists(src):
            print(f"  跳过 {name}:源图不存在 {src}")
            sys.exit(1)
        normalize(src, os.path.join(OUTPUT_DIR, name + ".png"))
    print("完成")


if __name__ == "__main__":
    main()
