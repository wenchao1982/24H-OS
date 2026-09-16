#!/usr/bin/env python3
"""从 build/icon.png（1024×1024 母版）生成 Windows 需要的 build/icon.ico（多尺寸）。

为什么单独一个脚本：图标是"品牌资产"，母版（icon.png）由设计决定，ico 只是它的派生物。
换品牌时只替换 build/icon.png，然后重跑这个脚本即可，不要手改 ico。

依赖 Pillow（一次性）：
    python3 -m venv .venv-icons && .venv-icons/bin/pip install pillow
    # 国内：加 --index-url https://mirrors.aliyun.com/pypi/simple/

用法：
    python scripts/make-icons.py                 # 生成 build/icon.ico（含 16/24/32/48/64/128/256）
    python scripts/make-icons.py --master foo.png --out bar.ico

说明：本仓现在带的是"深色圆角底 + 蓝色表盘环 + 24H"的默认图标，母版也一并放在 build/icon.png，
换图只需替换母版再跑本脚本。Electron 打包（electron-builder）只认 .ico，所以这一步是发版前必做。
"""
from __future__ import annotations

import argparse
import pathlib
import sys

SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> int:
    ap = argparse.ArgumentParser()
    root = pathlib.Path(__file__).resolve().parent.parent
    ap.add_argument("--master", default=str(root / "build" / "icon.png"), help="1024×1024（或正方形）母版 PNG")
    ap.add_argument("--out", default=str(root / "build" / "icon.ico"), help="输出的 .ico")
    ap.add_argument("--sizes", default=",".join(str(s) for s in SIZES), help="要嵌入的尺寸，逗号分隔")
    args = ap.parse_args()

    try:
        from PIL import Image
    except ImportError:
        print("需要 Pillow：pip install pillow（国内可加 --index-url https://mirrors.aliyun.com/pypi/simple/）", file=sys.stderr)
        return 2

    master = pathlib.Path(args.master)
    if not master.exists():
        print(f"找不到母版：{master}", file=sys.stderr)
        return 1

    img = Image.open(master).convert("RGBA")
    if img.width != img.height:
        print(f"母版必须是正方形，当前 {img.width}×{img.height}", file=sys.stderr)
        return 1

    sizes = [(int(s), int(s)) for s in args.sizes.split(",") if s.strip()]
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # Pillow 会把母版按每个尺寸重采样后写进同一个 ico（Windows 各场景各取所需）
    img.resize((256, 256), Image.LANCZOS).save(out, format="ICO", sizes=sizes)
    print(f"✓ {out}（{out.stat().st_size} B，含尺寸 {', '.join(str(s[0]) for s in sizes)}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
