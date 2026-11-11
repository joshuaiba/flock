"""Build the site's art from the Flock illustration pack.

    uv run --with pillow python web/scripts/build-art.py /path/to/flock-assets

Writes web/public/art/. The pack's files are used as-is: this only resizes
(1x and 2x variants, never upscaling) and crops empty margins, as the pack's
INSTRUCTIONS.md allows. Nothing is redrawn or recolored. Sources are the
lossless .png files where the pack has them, so each variant is encoded once.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "art"

# (source without extension, output name, widths, crop box or None)
JOBS: list[tuple[str, str, list[int], tuple[int, int, int, int] | None]] = [
    ("hero/day/01-sky", "hero/sky", [836, 1672], None),
    ("hero/dusk/01-sky-dusk", "hero/sky-dusk", [1086, 2172], None),
    ("hero/day/02-midground", "hero/midground", [1085, 2170], None),
    ("hero/day/03-lake", "hero/lake", [1085, 2170], None),
    ("hero/day/04-foreground-frame", "hero/foreground", [1085, 2170], None),
    ("props/cloud-1", "props/cloud-1", [315, 629], None),
    ("props/cloud-2", "props/cloud-2", [284, 568], None),
    ("props/cloud-3", "props/cloud-3", [266, 531], None),
    ("props/sailboat", "props/sailboat", [160, 320], None),
    ("props/rowboat", "props/rowboat", [160, 320], None),
    ("props/swallow-glide-1", "props/swallow-glide-1", [123, 246], None),
    ("props/swallow-glide-2", "props/swallow-glide-2", [135], None),
    ("props/swallow-glide-3", "props/swallow-glide-3", [141], None),
    ("props/swallow-glide-4", "props/swallow-glide-4", [133], None),
    ("props/swallow-glide-5", "props/swallow-glide-5", [120], None),
    # Sprite strips: 8 cells of 260x390. Birds are drawn at most 56px wide, so a
    # half-size strip (130x195 cells) is sharp on a 2x display.
    ("sprites/swallow-award/swallow-award-strip", "sprites/swallow-award", [1040], None),
    (
        "sprites/swallow-solicitation/swallow-solicitation-strip",
        "sprites/swallow-solicitation",
        [1040],
        None,
    ),
    *[
        (f"medallions/medallion-{n}", f"medallions/{n}", [128, 256, 512], None)
        for n in ["anchor", "column", "compass", "laurel", "shield", "wing"]
    ],
    ("ornaments/laurel-garland", "ornaments/laurel-garland", [560, 1120], None),
    # The strip has soft ends and does not repeat edge to edge. This crop is a
    # whole number of meanders (9 x ~164.5px), so it tiles without a seam.
    ("ornaments/greek-key-border", "ornaments/greek-key", [278, 556], (219, 0, 1700, 128)),
    ("ornaments/cartouche", "ornaments/cartouche", [430, 861], None),
    ("ornaments/corner-vine", "ornaments/corner-vine", [220, 440], None),
    # The vignette sits in the left of a wide empty canvas: crop to the drawing.
    (
        "vignettes/empty-state-swallow-on-column",
        "vignettes/swallow-on-column",
        [280, 560],
        (24, 100, 930, 920),
    ),
    ("footer/footer-dusk-terrace", "footer/terrace", [1086, 2172], None),
    ("fresco/boscoreale-wall-faded", "fresco/wall", [1250, 2499], None),
    ("fresco/boscoreale-garland-band-faded", "fresco/garland-band", [1250, 2499], None),
]


def main(pack: Path) -> None:
    total = 0
    for src, name, widths, crop in JOBS:
        path = next(
            (
                pack / f"{src}{ext}"
                for ext in (".png", ".jpg", ".webp")
                if (pack / f"{src}{ext}").exists()
            ),
            None,
        )
        if path is None:
            raise SystemExit(f"missing in pack: {src}")
        im = Image.open(path)
        im = im.convert("RGBA" if "A" in im.getbands() or im.mode == "P" else "RGB")
        if crop:
            im = im.crop(crop)
        for w in widths:
            w = min(w, im.width)  # never upscale
            out = OUT / f"{name}-{w}.webp"
            out.parent.mkdir(parents=True, exist_ok=True)
            resized = (
                im
                if w == im.width
                else im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
            )
            resized.save(out, "WEBP", quality=86, method=6)
            size = out.stat().st_size
            total += size
            print(f"{out.relative_to(OUT)}  {resized.width}x{resized.height}  {size // 1024}K")
    print(f"total {total / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]))
