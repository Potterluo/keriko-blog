#!/usr/bin/env python3
"""从 B 站分 P 视频里抽取「有信息量」的画面帧，并拼成联系表。

用法：
    python scripts/video-frames.py --bvid BV15z4C6SEHT --part 5 --out .frames/p5

流程：pagelist 取 cid → playurl 取 480p 视频流 → ffmpeg 定长抽帧
→ 颜色/边缘打分剔除真人出镜与静止画面 → 去重 → 拼联系表。

依赖：ffmpeg、Pillow；B 站接口只需要普通 UA 与 Referer。
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
HEADERS = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}


def api(url: str) -> dict:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=25) as response:
        data = json.loads(response.read().decode("utf-8"))
    if data.get("code") != 0:
        raise SystemExit(f"接口返回 {data.get('code')}: {data.get('message')}")
    return data["data"]


def resolve_part(bvid: str, part: int) -> tuple[int, str, int]:
    pages = api(f"https://api.bilibili.com/x/player/pagelist?bvid={bvid}")
    if not 1 <= part <= len(pages):
        raise SystemExit(f"分 P 越界：共 {len(pages)} 个")
    page = pages[part - 1]
    return page["cid"], page["part"], page["duration"]


def download(bvid: str, cid: int, out: Path) -> Path:
    target = out / "video.m4s"
    if target.exists() and target.stat().st_size > 0:
        return target
    dash = api(f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&fnval=16&fourk=0")["dash"]
    streams = [s for s in dash["video"] if s["height"] <= 480] or dash["video"]
    best = max(streams, key=lambda s: s["bandwidth"])
    request = urllib.request.Request(
        best["baseUrl"],
        headers={"User-Agent": UA, "Referer": f"https://www.bilibili.com/video/{bvid}/"},
    )
    with urllib.request.urlopen(request, timeout=300) as response, target.open("wb") as handle:
        handle.write(response.read())
    print(f"下载完成 {best['width']}x{best['height']} {target.stat().st_size / 1e6:.1f} MB")
    return target


def sample(video: Path, raw: Path, interval: float, crop_bottom: float) -> list[Path]:
    raw.mkdir(parents=True, exist_ok=True)
    for stale in raw.glob("*.png"):
        stale.unlink()
    # 掐掉底部字幕条：B 站视频常把讲解字幕烧进画面，做参考图时是噪音。
    crop = f"crop=iw:ih*{1 - crop_bottom:.3f}:0:0," if crop_bottom > 0 else ""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video),
         "-vf", f"{crop}fps=1/{interval},scale=640:-1", str(raw / "f-%03d.png")],
        check=True,
    )
    return sorted(raw.glob("f-*.png"))


def score(path: Path) -> tuple[float, float]:
    """返回 (饱和度, 边缘密度)。板书画面的特征：近乎无彩、线条密集。"""
    from PIL import Image, ImageFilter, ImageStat

    image = Image.open(path).convert("RGB")
    hsv = image.convert("HSV")
    saturation = ImageStat.Stat(hsv.getchannel("S")).mean[0] / 255
    edges = image.convert("L").filter(ImageFilter.FIND_EDGES)
    edge_density = ImageStat.Stat(edges).mean[0] / 255
    return saturation, edge_density


def dedupe(frames: list[Path], threshold: float) -> list[Path]:
    from PIL import Image

    kept: list[Path] = []
    previous: list[tuple[int, int, int]] | None = None
    for frame in frames:
        pixels = list(Image.open(frame).convert("RGB").resize((64, 36)).getdata())
        if previous is None:
            kept.append(frame)
        else:
            distance = sum(
                abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])
                for a, b in zip(pixels, previous)
            ) / (64 * 36 * 3)
            if distance > threshold:
                kept.append(frame)
        previous = pixels
    return kept


def sheet(frames: list[Path], out: Path, cols: int, width: int) -> None:
    from PIL import Image

    thumbs = [Image.open(frame).convert("RGB") for frame in frames]
    height = int(width * thumbs[0].height / thumbs[0].width)
    rows = math.ceil(len(thumbs) / cols)
    canvas = Image.new("RGB", (cols * width + (cols + 1) * 8, rows * height + (rows + 1) * 8), "white")
    for index, thumb in enumerate(thumbs):
        row, col = divmod(index, cols)
        canvas.paste(thumb.resize((width, height)), (8 + col * (width + 8), 8 + row * (height + 8)))
    canvas.save(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bvid", required=True)
    parser.add_argument("--part", type=int, default=1)
    parser.add_argument("--out", default=".frames/out")
    parser.add_argument("--interval", type=float, default=8.0, help="抽帧间隔（秒）")
    parser.add_argument("--min-edge", type=float, default=0.020, help="边缘密度下限，低于此判为画面无信息")
    parser.add_argument("--max-saturation", type=float, default=0.12, help="饱和度上限，高于此判为真人出镜")
    parser.add_argument("--threshold", type=float, default=3.0, help="相邻帧差异阈值")
    parser.add_argument("--cols", type=int, default=5)
    parser.add_argument("--width", type=int, default=320, help="联系表单张宽度")
    parser.add_argument("--crop-bottom", type=float, default=0.0, help="按比例裁掉画面底部（通常是烧进画面的字幕条）")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    cid, title, duration = resolve_part(args.bvid, args.part)
    print(f"P{args.part} {title} （{duration}s, cid={cid}）")

    video = download(args.bvid, cid, out)
    frames = sample(video, out / "raw", args.interval, args.crop_bottom)
    print(f"抽帧 {len(frames)} 张")

    informative = []
    for frame in frames:
        saturation, edge = score(frame)
        if saturation <= args.max_saturation and edge >= args.min_edge:
            informative.append(frame)
    print(f"过滤后 {len(informative)} 张（剔掉出镜与空镜）")

    kept = dedupe(informative, args.threshold)
    print(f"去重后 {len(kept)} 张")

    for index, frame in enumerate(kept, start=1):
        seconds = float(frame.stem.split("-")[1]) * args.interval
        print(f"  {index:02d}  {int(seconds // 60):02d}:{int(seconds % 60):02d}  {frame.name}")

    if kept:
        target = out / "sheet.png"
        sheet(kept, target, args.cols, args.width)
        print(f"联系表 {target} {target.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
