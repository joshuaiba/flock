"""Build the site's art from the Flock engraving pack.

    uv run --with pillow python web/scripts/build-art.py /path/to/flock-engraving \\
        [/path/to/forum-additions/art/figures]

Writes web/public/art/on-dark/ (light lines, for the dark page) and
web/public/art/on-light/ (ink lines, for paper). Every file in the pack is one
flat color with an alpha channel, in both tones; the site shows the tone that
suits the mode. The files are used as they are: this only resizes (1x and 2x
variants, never upscaling) and crops, as the pack's INSTRUCTIONS.md allows.
Nothing is redrawn, recolored or sharpened.

The optional second folder holds the Forum's margin figures (nike, athena,
trophy), which come as `<name>-on-dark.png` and `<name>-on-light.png`.

Only the art the site uses is built. The pack also has the hero's separate
midground and lake, the boats, two more glide poses, the laurel garland, the
Greek key and the title plaque.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "art"
TONES = ("on-dark", "on-light")

# (source without extension, output name, widths, crop box or None)
Job = tuple[str, str, list[int], tuple[int, int, int, int] | None]

JOBS: list[Job] = [
    # Village, lake and boats on one 2170x905 canvas. The waterline already
    # meets the foot of the houses, so the site needs no offsets of its own.
    ("hero/scene", "hero/scene", [1085, 2170], None),
    # The Field Report's margin: the left 27% of the vine frame.
    ("hero/foreground-frame", "margins/vine", [293, 586], (0, 0, 586, 725)),
    # One glide pose for the entity page's path to production, and three for
    # the flock (those that face right and read as level flight).
    ("props/swallow-glide-1", "props/swallow-glide-1", [123, 246], None),
    ("props/swallow-glide-2", "props/swallow-glide-2", [135], None),
    ("props/swallow-glide-4", "props/swallow-glide-4", [133], None),
    ("props/swallow-glide-5", "props/swallow-glide-5", [120], None),
    # Sprite strips: 8 cells of 260x390, the award strip in the accent and the
    # solicitation strip in the text color. Birds are drawn at most 60px wide,
    # so a half-size strip (130x195 cells) is sharp on a 2x display.
    ("sprites/swallow-award-strip", "sprites/swallow-award", [1040], None),
    ("sprites/swallow-solicitation-strip", "sprites/swallow-solicitation", [1040], None),
    # Small category icons.
    *[
        (f"medallions/medallion-{n}", f"medallions/{n}", [64, 128], None)
        for n in ["anchor", "column", "compass", "laurel", "shield", "wing"]
    ],
    # The vignette sits in the left of a wide empty canvas: crop to the drawing.
    ("vignettes/swallow-on-column", "vignettes/swallow-on-column", [280, 560], (24, 100, 930, 920)),
    ("footer/terrace", "footer/terrace", [1086, 2172], None),
    # A photograph of a Roman wall painting, kept as a tonal ghost with faded
    # edges (a painting has no linework to extract).
    ("fresco/boscoreale-wall", "fresco/wall", [625, 1250], None),
    ("fresco/boscoreale-garland-band", "fresco/garland-band", [625, 1250], None),
]

# The Forum's margin figures, drawn up to 780px tall. One size each: fine
# linework compresses no better at half size.
FIGURES: list[tuple[str, list[int]]] = [
    ("nike", [973]),
    ("athena", [619]),
    ("trophy", [736]),
]


def find(folder: Path, stem: str) -> Path:
    for ext in (".png", ".webp"):
        if (folder / f"{stem}{ext}").exists():
            return folder / f"{stem}{ext}"
    raise SystemExit(f"missing: {folder / stem}")


def build(src: Path, out_stem: Path, widths: list[int], crop: tuple[int, int, int, int] | None) -> int:
    im = Image.open(src).convert("RGBA")
    if crop:
        im = im.crop(crop)
    total = 0
    for w in widths:
        w = min(w, im.width)  # never upscale
        out = out_stem.parent / f"{out_stem.name}-{w}.webp"
        out.parent.mkdir(parents=True, exist_ok=True)
        resized = im if w == im.width else im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        # exact=True keeps the flat color under transparent pixels, so a faded
        # edge never picks up a dark fringe when the browser scales the image.
        resized.save(out, "WEBP", quality=86, method=6, exact=True)
        size = out.stat().st_size
        total += size
        print(f"{out.relative_to(OUT)}  {resized.width}x{resized.height}  {size // 1024}K")
    return total


def main(pack: Path, figures: Path | None) -> None:
    # Start clean, so art the site no longer uses does not linger.
    if OUT.exists():
        shutil.rmtree(OUT)
    total = 0
    for tone in TONES:
        for src, name, widths, crop in JOBS:
            total += build(find(pack / tone, src), OUT / tone / name, widths, crop)
        if figures:
            for name, widths in FIGURES:
                total += build(find(figures, f"{name}-{tone}"), OUT / tone / "figures" / name, widths, None)
    print(f"total {total / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) == 3 else None)
