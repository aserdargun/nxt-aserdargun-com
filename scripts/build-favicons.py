#!/usr/bin/env python3
"""Generate NXT compass favicon PNGs and ICO from the SVG source design.

The SVG ships in web/public/favicon.svg; this script mirrors that visual
into raster formats that browsers without SVG favicon support can still
load (legacy Edge/IE .ico, classic tab .png, iOS home screen .png).
"""
from __future__ import annotations

from math import cos, pi, sin
from pathlib import Path

from PIL import Image, ImageDraw

WEB_PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public"

BG_TOP = (58, 56, 56)        # #3a3838
BG_BOTTOM = (29, 32, 33)     # #1d2021
BORDER = (80, 73, 69)        # #504945
RING = (102, 92, 84)         # #665c54
TICK = (168, 153, 132)       # #a89984
TICK_SUBTLE = (124, 111, 100)  # #7c6f64
NEEDLE_NORTH_TOP = (254, 128, 25)   # #fe8019
NEEDLE_NORTH_BOTTOM = (251, 73, 52)  # #fb4934
NEEDLE_SOUTH_TOP = (235, 219, 178)   # #ebdbb2
NEEDLE_SOUTH_BOTTOM = (168, 153, 132)  # #a89984
HUB_DARK = (29, 32, 33)      # #1d2021
HUB_RING = (168, 153, 132)   # #a89984


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def bg_color(y: int, size: int) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, (y - 0.32 * size) / (0.36 * size))) if size > 0 else 0.0
    t = max(0.0, min(1.0, t))
    return (lerp(BG_TOP[0], BG_BOTTOM[0], t),
            lerp(BG_TOP[1], BG_BOTTOM[1], t),
            lerp(BG_TOP[2], BG_BOTTOM[2], t))


def needle_color(y: int, top: int, bottom: int, north: bool) -> tuple[int, int, int]:
    span = bottom - top
    t = 0.0 if span == 0 else max(0.0, min(1.0, (y - top) / span))
    src = NEEDLE_NORTH_TOP if north else NEEDLE_SOUTH_TOP
    dst = NEEDLE_NORTH_BOTTOM if north else NEEDLE_SOUTH_BOTTOM
    return (lerp(src[0], dst[0], t), lerp(src[1], dst[1], t), lerp(src[2], dst[2], t))


def draw_needle(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: int, north: bool) -> None:
    radius = 0.323 * size
    tip_y = cy - radius if north else cy + radius
    base_y = cy + (0.04 * size if north else -0.04 * size)
    inner_top_y = cy - 0.046 * size if north else cy + 0.046 * size
    inner_bottom_y = cy + 0.014 * size if north else cy - 0.014 * size
    half_width = 0.041 * size
    inner_half = 0.022 * size
    outer_top = (cx, tip_y)
    outer_right = (cx + half_width, base_y)
    inner_right = (cx + inner_half, inner_top_y)
    inner_left = (cx - inner_half, inner_bottom_y)
    outer_left = (cx - half_width, base_y)
    polygon = [outer_top, outer_right, inner_right, inner_left, outer_left]
    top_y = int(min(point[1] for point in polygon))
    bottom_y = int(max(point[1] for point in polygon)) + 1
    if top_y == bottom_y:
        bottom_y = top_y + 1
    y_range = bottom_y - top_y
    mask = Image.new("L", (int(size), int(size)), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.polygon(polygon, fill=255)
    band = Image.new("RGB", (int(size), y_range), (0, 0, 0))
    band_pixels = band.load()
    for y in range(y_range):
        color = needle_color(top_y + y, top_y, bottom_y - 1, north)
        for x in range(int(size)):
            band_pixels[x, y] = color
    draw._image.paste(band, (0, top_y), mask.crop((0, top_y, int(size), bottom_y)))


def render(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    pixels = image.load()
    radius = int(round(0.1875 * size))
    for y in range(size):
        for x in range(size):
            in_rounded = (x < radius and y < radius and (radius - x) ** 2 + (radius - y) ** 2 > radius ** 2) or \
                         (x >= size - radius and y < radius and (x - (size - radius - 1)) ** 2 + (radius - y) ** 2 > radius ** 2) or \
                         (x < radius and y >= size - radius and (radius - x) ** 2 + (y - (size - radius - 1)) ** 2 > radius ** 2) or \
                         (x >= size - radius and y >= size - radius and (x - (size - radius - 1)) ** 2 + (y - (size - radius - 1)) ** 2 > radius ** 2)
            if in_rounded:
                continue
            pixels[x, y] = (*bg_color(y, size), 255)
    cx = cy = size / 2
    ring_r = 0.35 * size
    line_w = max(1, int(round(0.028 * size)))
    draw.ellipse((cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r), outline=RING, width=line_w)
    tick_len = 0.069 * size
    tick_w = max(1, int(round(0.022 * size)))
    for angle in (0, 90, 180, 270):
        rad = (angle - 90) * pi / 180
        outer = (cx + (ring_r - 0.005 * size) * cos(rad), cy + (ring_r - 0.005 * size) * sin(rad))
        inner = (cx + (ring_r - tick_len) * cos(rad), cy + (ring_r - tick_len) * sin(rad))
        draw.line([inner, outer], fill=TICK, width=tick_w)
    for angle in (45, 135, 225, 315):
        rad = (angle - 90) * pi / 180
        outer = (cx + (ring_r - 0.005 * size) * cos(rad), cy + (ring_r - 0.005 * size) * sin(rad))
        inner = (cx + (ring_r - 0.046 * size) * cos(rad), cy + (ring_r - 0.046 * size) * sin(rad))
        draw.line([inner, outer], fill=TICK_SUBTLE, width=max(1, int(round(0.015 * size))))
    draw_needle(draw, cx, cy, size, north=True)
    draw_needle(draw, cx, cy, size, north=False)
    hub_r = 0.034 * size
    draw.ellipse((cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r), fill=HUB_DARK, outline=HUB_RING, width=max(1, int(round(0.009 * size))))
    border_w = max(1, int(round(0.031 * size)))
    border_r = radius
    inner = border_w // 2
    outer = border_w - inner
    draw.rounded_rectangle((inner, inner, size - 1 - outer, size - 1 - outer), radius=border_r, outline=BORDER, width=border_w)
    return image


def main() -> None:
    WEB_PUBLIC.mkdir(parents=True, exist_ok=True)
    targets = [
        ("favicon-16x16.png", 16),
        ("favicon-32x32.png", 32),
        ("apple-touch-icon.png", 180),
    ]
    ico_frames = []
    for filename, size in targets:
        rendered = render(size)
        rendered.save(WEB_PUBLIC / filename, format="PNG", optimize=True)
        if size in (16, 32):
            ico_frames.append(rendered.convert("RGBA"))
    ico_base = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    ico_base.paste(ico_frames[1], (0, 0))
    ico_base.save(
        WEB_PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32)],
        append_images=[ico_frames[0]],
    )
    print("Generated favicon assets in", WEB_PUBLIC)


if __name__ == "__main__":
    main()
