"""Build the site's art from the Flock engraving pack.

    uv run --with pillow python web/scripts/build-art.py /path/to/flock-art/flock-engraving \\
        /path/to/flock-art/flock-hero /path/to/flock-art/forum-additions/art/figures \\
        /path/to/flock-classic [/path/to/flock-nodes]

    uv run --with pillow python web/scripts/build-art.py --nodes /path/to/flock-nodes

The first form is the full build: it deletes web/public/art and rebuilds all
of it, including the graph's node art when the fifth folder is given. Some art
under web/public/art was placed by hand and has no source here (the engraved
footer terrace is one), so check `git status web/public/art` after a full
build and restore what it dropped. The second form builds only the node art,
into web/public/art/<tone>/nodes/, and deletes nothing.

Writes web/public/art/on-dark/ (light lines, for the dark page),
web/public/art/on-light/ (ink lines, for paper and Classic) and
web/public/art/classic/ (the painted art that only the Classic mode shows).
Every file in the engraving pack is one flat color with an alpha channel, in
both tones; the site shows the tone that suits the mode. The files are used as they are: this only resizes (1x and 2x
variants, never upscaling) and crops, as the pack's INSTRUCTIONS.md allows.
Nothing is redrawn, recolored or sharpened.

The second folder is the landing hero's own pack: the lakeside village as one
clean line engraving with no boats in it, and the two boats as separate files,
because the site moves them (`on-dark/scene.png`, `rowboat.png`, `sailboat.png`,
and the same under `on-light/`).

The third folder holds the Forum's margin figures (nike, athena, trophy), which
come as `<name>-on-dark.png` and `<name>-on-light.png`.

The fourth folder is the Classic pack. Its `about-frieze/` holds the About
section's frieze, a photograph of the Pergamon Altar kept as a tonal ghost in
both tones (`pergamon-athena-on-dark.png`, `-on-light.png`). The rest of it is
the painted design the site began with, in full color and one tone: the
Display menu's third mode, Classic, shows it on the landing page.

The fifth folder is the graph's node pack (flock-nodes): coins, wreaths,
tablets and the selection crown, one 256px square sprite each in both tones
(the tablets are 128px and the crown 384px), written to `nodes/`.

Only the art the site uses is built. The engraving pack also has an older hero
scene, two more glide poses, the laurel garland, the Greek key and the title
plaque.
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
        for n in ["anchor", "compass", "laurel", "shield", "wing"]
    ],
    # The vignette sits in the left of a wide empty canvas: crop to the drawing.
    ("vignettes/swallow-on-column", "vignettes/swallow-on-column", [280, 560], (24, 100, 930, 920)),
    ("footer/terrace", "footer/terrace", [1086, 2172], None),
    # A detail of a photograph of a Roman wall painting, kept as a tonal ghost
    # with faded edges (a painting has no linework to extract).
    ("fresco/boscoreale-garland-band", "fresco/garland-band", [625, 1250], None),
]

# The landing hero, from its own pack. The scene is village and lake on one
# 2170x905 canvas, with the waterline already at the foot of the houses, so the
# site needs no offsets of its own. The boats are drawn at most 180px wide.
HERO: list[tuple[str, list[int]]] = [
    ("scene", [1085, 2170]),
    ("rowboat", [160, 320]),
    ("sailboat", [160, 320]),
]

# The Forum's margin figures, drawn up to 780px tall. One size each: fine
# linework compresses no better at half size.
FIGURES: list[tuple[str, list[int]]] = [
    ("nike", [973]),
    ("athena", [619]),
    ("trophy", [736]),
]

# The About section's frieze, from the Classic pack: a photograph of the
# Pergamon Altar (Carole Raddato, CC BY-SA 2.0) as a tonal ghost with faded
# edges, 2164x1384. It is drawn at most 600px wide.
FRIEZE: list[tuple[str, str, list[int]]] = [
    ("about-frieze/pergamon-athena", "frieze/pergamon-athena", [600, 1200]),
]

# The Classic mode's painted art, from the Classic pack: full color, one tone.
# (source without extension, output name under classic/, widths). The boats
# are built at the engraved boats' sizes and the sprite strips at the engraved
# strips' size (half: 130x195 cells), so the site draws them the same way.
CLASSIC: list[tuple[str, str, list[int]]] = [
    ("hero/sky", "hero/sky", [836, 1672]),
    # Village and lake on the engraved scene's 2170x905 canvas, sky transparent.
    ("hero/scene", "hero/scene", [1085, 2170]),
    # The two halves of the leafy frame, drawn at most 560px wide.
    ("hero/frame-left", "hero/frame-left", [560, 976]),
    ("hero/frame-right", "hero/frame-right", [560, 977]),
    ("props/rowboat", "hero/rowboat", [160, 320]),
    ("props/sailboat", "hero/sailboat", [160, 320]),
    ("sprites/swallow-award-strip", "sprites/swallow-award", [1040]),
    ("sprites/swallow-solicitation-strip", "sprites/swallow-solicitation", [1040]),
    # About's frieze in color, its edges already faded to transparent.
    ("about-frieze/pergamon-athena-color", "frieze/pergamon-athena", [600, 1200]),
    ("footer/terrace", "footer/terrace", [1086, 2172]),
]

# The graph's node art, from the nodes pack: one square sprite per name in
# both tones, drawn from about 12px up to the crown's 1.6x a large node. Coins
# carry the five category families plus a plain one; wreaths are the agencies
# (Army oak, Navy rope, Air Force feather, the rest laurel); tablets are open
# and closed solicitations; the crown marks the selected node. Widths are
# 64/128/256, except the tablets, whose sources are 128px (build() never
# upscales, so they get 64 and 128 only), and the crown, which is 384px.
NODES: list[tuple[str, list[int]]] = [
    *[
        (f"coin-{n}", [64, 128, 256])
        for n in ["aerial", "maritime", "navigation", "counter", "other", "plain"]
    ],
    *[(f"wreath-{n}", [64, 128, 256]) for n in ["oak", "rope", "feather", "laurel"]],
    ("tablet-open", [64, 128]),
    ("tablet-closed", [64, 128]),
    ("crown-selected", [128, 384]),
]


def find(folder: Path, stem: str) -> Path:
    for ext in (".png", ".webp"):
        if (folder / f"{stem}{ext}").exists():
            return folder / f"{stem}{ext}"
    raise SystemExit(f"missing: {folder / stem}")


def build(
    src: Path, out_stem: Path, widths: list[int], crop: tuple[int, int, int, int] | None
) -> int:
    im = Image.open(src).convert("RGBA")
    if crop:
        im = im.crop(crop)
    total = 0
    for w in widths:
        w = min(w, im.width)  # never upscale
        out = out_stem.parent / f"{out_stem.name}-{w}.webp"
        out.parent.mkdir(parents=True, exist_ok=True)
        resized = (
            im if w == im.width else im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        )
        # exact=True keeps the flat color under transparent pixels, so a faded
        # edge never picks up a dark fringe when the browser scales the image.
        resized.save(out, "WEBP", quality=86, method=6, exact=True)
        size = out.stat().st_size
        total += size
        print(f"{out.relative_to(OUT)}  {resized.width}x{resized.height}  {size // 1024}K")
    return total


def build_nodes(nodes: Path) -> int:
    total = 0
    for tone in TONES:
        for name, widths in NODES:
            total += build(find(nodes / tone, name), OUT / tone / "nodes" / name, widths, None)
    return total


def main(pack: Path, hero: Path, figures: Path, classic: Path, nodes: Path | None = None) -> None:
    # Start clean, so art the site no longer uses does not linger.
    if OUT.exists():
        shutil.rmtree(OUT)
    total = 0
    for tone in TONES:
        for src, name, widths, crop in JOBS:
            total += build(find(pack / tone, src), OUT / tone / name, widths, crop)
        for name, widths in HERO:
            total += build(find(hero / tone, name), OUT / tone / "hero" / name, widths, None)
        for name, widths in FIGURES:
            total += build(
                find(figures, f"{name}-{tone}"), OUT / tone / "figures" / name, widths, None
            )
        for src, name, widths in FRIEZE:
            total += build(find(classic, f"{src}-{tone}"), OUT / tone / name, widths, None)
    for src, name, widths in CLASSIC:
        total += build(find(classic, src), OUT / "classic" / name, widths, None)
    if nodes:
        total += build_nodes(nodes)
    print(f"total {total / 1e6:.1f} MB")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "--nodes":
        # Only the node art, over whatever is already there: nothing is deleted.
        print(f"total {build_nodes(Path(args[1])) / 1e6:.1f} MB")
    elif len(args) in (4, 5):
        main(*(Path(a) for a in args))
    else:
        raise SystemExit(__doc__)
