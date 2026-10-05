#!/usr/bin/env python3
"""icon.png / icon-512.png and preview.png for the Marketplace listing.

    python3 tool/art.py

The preview is drawn, not captured, but nothing in it is invented: the squiggles
and the Problems list come from running lib/analyze.js over tool/sample.js, so
the picture cannot claim a check the code does not make.
"""
import json
import pathlib
import subprocess
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONTS = pathlib.Path.home() / "Library" / "Fonts"

GROUND = "#0D0D0F"
PANEL = "#141417"
MINT = "#3DDC97"
TEXT = "#E8E8E8"
DIM = "#8A8A92"
RED = "#F0625A"
AMBER = "#E2B25A"
BLUE = "#6FA8DC"
KEY = "#C792EA"
STRING = "#C3E88D"
NUMBER = "#F78C6C"

SEVERITY = {"error": RED, "warning": AMBER, "info": BLUE}


def face(*candidates):
    for c in candidates:
        if pathlib.Path(c).exists():
            return str(c)
    raise SystemExit(f"  none of these fonts is installed: {[str(c) for c in candidates]}")


UI = face(FONTS / "Inter-Medium.ttf", "/System/Library/Fonts/Helvetica.ttc")
MONO = face(FONTS / "JetBrainsMono-Regular.ttf", FONTS / "VictorMono-Regular.ttf",
            "/System/Library/Fonts/Menlo.ttc")


def sample():
    """What the analyzer says about tool/sample.js — the code the extension runs."""
    try:
        with urllib.request.urlopen("https://pub.dev/api/packages/http", timeout=15) as r:
            http_latest = json.load(r)["latest"]["version"]
    except Exception:
        http_latest = "1.5.0"
    out = subprocess.run(["node", "tool/sample.js", http_latest], capture_output=True,
                         text=True, cwd=ROOT, check=True)
    return json.loads(out.stdout)


def squiggle(d, x0, x1, y, colour, weight, amp=6, period=16):
    pts = []
    x = x0
    up = True
    while x <= x1:
        pts.append((x, y - amp if up else y + amp))
        x += period / 2
        up = not up
    d.line(pts, fill=colour, width=weight, joint="curve")


def icon():
    s = 512
    img = Image.new("RGB", (s, s), GROUND)
    d = ImageDraw.Draw(img)
    # A package: a box with its lid seam.
    d.rounded_rectangle([96, 120, 416, 400], 36, outline=MINT, width=24)
    d.line([(96, 196), (416, 196)], fill=MINT, width=20)
    d.rounded_rectangle([226, 120, 286, 196], 4, fill=MINT)
    # And its pulse, flat, a beat, flat — with one missed beat in red.
    beat = [(132, 304), (196, 304), (218, 262), (246, 344), (268, 304), (300, 304)]
    d.line(beat, fill=MINT, width=18, joint="curve")
    d.line([(300, 304), (322, 304)], fill=MINT, width=18)
    d.ellipse([340, 290, 368, 318], fill=RED)
    img.save(ROOT / "icon-512.png", optimize=True)
    img.resize((128, 128), Image.LANCZOS).save(ROOT / "icon.png", optimize=True)
    print("  icon.png 128, icon-512.png 512")


def tokens(line):
    """(text, colour) runs for one pubspec line: keys, values, comments."""
    stripped = line.lstrip(" ")
    indent = line[: len(line) - len(stripped)]
    if not stripped:
        return [(line, TEXT)]
    if stripped.startswith("#"):
        return [(line, DIM)]
    if ":" in stripped:
        key, rest = stripped.split(":", 1)
        value = rest.strip()
        colour = NUMBER if value[:1] in "^0123456789" else STRING
        return [(indent, TEXT), (key, KEY), (":", TEXT), (rest, colour)]
    return [(line, TEXT)]


def preview():
    data = sample()
    lines, found = data["lines"], data["findings"]
    code = ImageFont.truetype(MONO, 21)
    ui = ImageFont.truetype(UI, 17)
    small = ImageFont.truetype(UI, 15)
    line_h, x0, y0 = 34, 96, 70
    problems = [f for f in found if f["severity"] != "hint"]
    w = 1400
    h = y0 + line_h * len(lines) + 70 + 44 * len(problems) + 40
    img = Image.new("RGB", (w, h), GROUND)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, w, 44], fill=PANEL)
    d.text((24, 12), "pubspec.yaml", font=ui, fill=TEXT)
    d.line([(20, 43), (140, 43)], fill=MINT, width=2)

    cw = d.textlength("m", font=code)
    for i, ln in enumerate(lines):
        y = y0 + i * line_h
        d.text((x0 - 56, y), f"{i + 1:>2}", font=code, fill="#4A4A52")
        x = x0
        for text, colour in tokens(ln):
            d.text((x, y), text, font=code, fill=colour)
            x += cw * len(text)

    # Least severe first, so where two share a range the worse one is on top.
    rank = {"hint": 0, "info": 1, "warning": 2, "error": 3}
    for f in sorted(found, key=lambda f: rank[f["severity"]]):
        xa, xb = x0 + f["start"] * cw, x0 + f["end"] * cw
        y = y0 + f["line"] * line_h + 29
        if f["severity"] == "hint":
            for k in range(3):
                d.ellipse([xa + k * 7, y - 1, xa + k * 7 + 3, y + 2], fill=DIM)
        else:
            squiggle(d, xa, xb, y, SEVERITY[f["severity"]], 2, amp=2.5, period=7)

    top = y0 + line_h * len(lines) + 30
    d.rectangle([0, top, w, h], fill=PANEL)
    d.text((24, top + 14), "PROBLEMS", font=small, fill=TEXT)
    d.line([(20, top + 40), (110, top + 40)], fill=MINT, width=2)
    order = {"error": 0, "warning": 1, "info": 2}
    y = top + 60
    for f in sorted(problems, key=lambda f: (order[f["severity"]], f["line"])):
        colour = SEVERITY[f["severity"]]
        d.ellipse([28, y + 5, 40, y + 17], fill=colour)
        words = f["message"].split(" ")
        room = w - 330
        msg = " ".join(words)
        while d.textlength(msg, font=ui) > room and len(words) > 1:
            words.pop()
            msg = " ".join(words).rstrip(",.;:—") + " …"
        d.text((54, y), msg, font=ui, fill=TEXT)
        d.text((w - 24, y), f'{f["id"]}   [Ln {f["line"] + 1}]', font=small, fill=DIM, anchor="ra")
        y += 44

    img.save(ROOT / "preview.png", optimize=True)
    print(f"  preview.png {w}x{h}  ({len(problems)} problems, {len(found) - len(problems)} hints)")


if __name__ == "__main__":
    icon()
    preview()
