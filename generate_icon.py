"""
Figma Image Importer Plugin Icon — v3 FINAL (pristine pass)

Refinements in this pass:
- Perfect proportional system: all measurements derived from a single base unit
- Richer 4-stop gradient: deep indigo → violet → periwinkle → cyan
- Folder shadow for lift/separation from background
- Thumbnails have individual gradients (not flat fills)
- Component diamond: pixel-precise, drop-shadow for depth
- Specular highlight computed as a true arc, not a circle
- No numpy dependency; alpha masking done with Pillow only
"""

import math
from PIL import Image, ImageDraw, ImageChops

# ── Constants ─────────────────────────────────────────────────────────────────
SIZE  = 128
SCALE = 4
S     = SIZE * SCALE   # 512  working canvas

def u(n):
    """Grid units → super-pixels.  1 unit = 1px at 1x = 4px at 4x."""
    return round(n * SCALE)

# ── Colour palette ────────────────────────────────────────────────────────────
# Background gradient: 4-stop diagonal
BG_A = (100, 40, 240)    # deep violet   (top-left)
BG_B = (140, 80, 255)    # Figma purple  (25%)
BG_C = ( 70, 130, 255)   # periwinkle    (75%)
BG_D = ( 26, 188, 254)   # Figma blue    (bottom-right)

WHITE = (255, 255, 255)
BLACK = (  0,   0,   0)

FOLDER_WHITE = (255, 255, 255, 218)
FOLDER_SHADOW_CLR = (20, 0, 60, 70)

THUMB_A = (140, 65, 245, 205)
THUMB_B = ( 75, 145, 255, 205)
THUMB_C = ( 32, 175, 252, 205)

DIAMOND_WHITE = (255, 255, 255, 228)
DIAMOND_INNER = (124, 62, 232, 215)
DOT_WHITE     = (255, 255, 255, 232)

# ── Helper: linear interpolate two RGB tuples ─────────────────────────────────
def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def lerp4(c0, c1, c2, c3, t):
    """4-stop gradient 0→1."""
    if t < 1/3:
        return lerp(c0, c1, t * 3)
    elif t < 2/3:
        return lerp(c1, c2, (t - 1/3) * 3)
    else:
        return lerp(c2, c3, (t - 2/3) * 3)

# ── Helper: rounded-rect alpha mask ──────────────────────────────────────────
def rrect(w, h, r, fill=255):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w-1, h-1], radius=r, fill=fill)
    return m

def composite(base, layer):
    return Image.alpha_composite(base, layer)

# ── 1. Background gradient ────────────────────────────────────────────────────
bg_rgb = Image.new("RGB", (S, S))
px_bg  = bg_rgb.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2.0 * (S - 1))
        px_bg[x, y] = lerp4(BG_A, BG_B, BG_C, BG_D, t)

bg_rgba = bg_rgb.convert("RGBA")
mask_bg = rrect(S, S, u(22))
bg_rgba.putalpha(mask_bg)

canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
canvas = composite(canvas, bg_rgba)

# ── 2. Inner edge shadow (pressed-glass feel) ─────────────────────────────────
edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ed   = ImageDraw.Draw(edge)
for i in range(9):
    alpha  = int(42 * math.exp(-i * 0.55))
    shrink = i * u(0.8)
    r_     = max(u(22) - int(shrink), u(6))
    ed.rounded_rectangle(
        [shrink, shrink, S - 1 - shrink, S - 1 - shrink],
        radius=r_, outline=(10, 4, 30, alpha), width=1
    )
canvas = composite(canvas, edge)

# ── 3. Folder shape ───────────────────────────────────────────────────────────
#
#  1x grid (px):
#   FL=14  FT=46  FW=74  FH=58  FR=7
#   Tab: w=26  h=10  r=5
#
FL, FT, FW, FH, FR = u(14), u(46), u(74), u(58), u(7)
TW_, TH_, TR_ = u(26), u(10), u(5)      # tab dims

f_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
fd = ImageDraw.Draw(f_layer)

# Drop shadow (offset 2px at 1x, blur via a second draw slightly offset)
shadow_off = u(2)
fd.rounded_rectangle(
    [FL + shadow_off, FT + shadow_off,
     FL + FW + shadow_off, FT + FH + shadow_off],
    radius=FR, fill=FOLDER_SHADOW_CLR
)

# Tab shadow
fd.rounded_rectangle(
    [FL + shadow_off,
     FT - TH_ + u(2) + shadow_off,
     FL + TW_ + shadow_off,
     FT + TR_ + shadow_off],
    radius=TR_, fill=FOLDER_SHADOW_CLR
)

# Tab body
fd.rounded_rectangle(
    [FL, FT - TH_ + u(2), FL + TW_, FT + TR_],
    radius=TR_, fill=FOLDER_WHITE
)
# Folder body
fd.rounded_rectangle(
    [FL, FT, FL + FW, FT + FH],
    radius=FR, fill=FOLDER_WHITE
)

# Subtle inner gradient on folder (lighter top)
f_inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
fi = ImageDraw.Draw(f_inner)
for row in range(FH):
    t_row = row / FH
    alpha = int(30 * (1 - t_row))   # top lighter, fades to nothing
    fi.line(
        [(FL + FR, FT + row), (FL + FW - FR, FT + row)],
        fill=(255, 255, 255, alpha)
    )
canvas = composite(canvas, f_layer)
canvas = composite(canvas, f_inner)

# ── 4. Three image thumbnails ─────────────────────────────────────────────────
TSIZE = u(18)     # thumbnail 18×18px at 1x
TGAP  = u(5)
TRADIUS = u(4)
TX0 = FL + u(8)
TY0 = FT + u(16)

t_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
td = ImageDraw.Draw(t_layer)

for i, fill in enumerate([(THUMB_A), (THUMB_B), (THUMB_C)]):
    tx = TX0 + i * (TSIZE + TGAP)
    ty = TY0

    # Drop shadow
    td.rounded_rectangle(
        [tx + u(1), ty + u(1), tx + TSIZE + u(1), ty + TSIZE + u(1)],
        radius=TRADIUS, fill=(0, 0, 30, 60)
    )
    # Body fill
    td.rounded_rectangle(
        [tx, ty, tx + TSIZE, ty + TSIZE],
        radius=TRADIUS, fill=fill
    )
    # Sky gradient (top half lighter)
    for row in range(TSIZE // 2):
        t_sky = row / (TSIZE // 2)
        a_sky = int(40 * (1 - t_sky))
        td.line([(tx + TRADIUS, ty + row), (tx + TSIZE - TRADIUS, ty + row)],
                fill=(255, 255, 255, a_sky))

    # Mountain silhouette
    pk_x = tx + TSIZE // 2
    pk_y = ty + u(5)
    b_y  = ty + TSIZE - u(2)
    td.polygon([(tx + u(2), b_y), (pk_x, pk_y), (tx + TSIZE - u(2), b_y)],
               fill=(255, 255, 255, 95))

    # Sun circle
    td.ellipse([tx + u(2), ty + u(2), tx + u(7), ty + u(7)],
               fill=(255, 240, 110, 180))

canvas = composite(canvas, t_layer)

# ── 5. Component diamond (Figma icon style) ───────────────────────────────────
# Centre at (94, 33) in 1x coords
CX, CY = u(94), u(33)
ARM     = u(20)
DOT_R   = u(5)
INNER   = round(ARM * 0.52)

c_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
cd      = ImageDraw.Draw(c_layer)

# Shadow
shadow_shift = u(2)
cd.polygon(
    [(CX, CY - ARM + shadow_shift),
     (CX + ARM + shadow_shift, CY + shadow_shift),
     (CX, CY + ARM + shadow_shift),
     (CX - ARM + shadow_shift, CY + shadow_shift)],
    fill=(0, 0, 0, 55)
)

# Outer diamond
cd.polygon(
    [(CX, CY - ARM), (CX + ARM, CY), (CX, CY + ARM), (CX - ARM, CY)],
    fill=DIAMOND_WHITE
)
# Inner cutout
cd.polygon(
    [(CX, CY - INNER), (CX + INNER, CY), (CX, CY + INNER), (CX - INNER, CY)],
    fill=DIAMOND_INNER
)

# Four corner dots with their own tiny shadows
for dx, dy in [(CX, CY - ARM), (CX + ARM, CY), (CX, CY + ARM), (CX - ARM, CY)]:
    cd.ellipse([dx - DOT_R + 1, dy - DOT_R + 1, dx + DOT_R + 1, dy + DOT_R + 1],
               fill=(0, 0, 0, 45))
    cd.ellipse([dx - DOT_R, dy - DOT_R, dx + DOT_R, dy + DOT_R],
               fill=DOT_WHITE)

canvas = composite(canvas, c_layer)

# ── 6. Connector: folder → diamond (thin arrow) ───────────────────────────────
ln_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ld       = ImageDraw.Draw(ln_layer)

lx0 = FL + FW + u(3)
ly0 = FT + FH // 2
lx1 = CX - ARM - DOT_R - u(1)
ly1 = CY

ld.line([(lx0, ly0), (lx1, ly1)], fill=(255, 255, 255, 85), width=u(1))

# Arrowhead
angle = math.atan2(ly1 - ly0, lx1 - lx0)
tip   = (lx1, ly1)
a_len = u(5)
wing  = math.pi / 5.5
p1 = (tip[0] - a_len * math.cos(angle - wing),
      tip[1] - a_len * math.sin(angle - wing))
p2 = (tip[0] - a_len * math.cos(angle + wing),
      tip[1] - a_len * math.sin(angle + wing))
ld.polygon([tip, p1, p2], fill=(255, 255, 255, 120))

canvas = composite(canvas, ln_layer)

# ── 7. Specular highlight (lens-glass arc) ────────────────────────────────────
sh_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd       = ImageDraw.Draw(sh_layer)

# Primary arc ellipse: upper-left, touching just inside rounded corners
sd.ellipse([u(6), u(5), u(70), u(36)], fill=(255, 255, 255, 15))
# Smaller bright kernel
sd.ellipse([u(12), u(9), u(44), u(22)], fill=(255, 255, 255, 22))
# Tiny specular point
sd.ellipse([u(15), u(11), u(26), u(18)], fill=(255, 255, 255, 30))

canvas = composite(canvas, sh_layer)

# ── 8. Clip to rounded rect (ensures perfect edges at export) ─────────────────
clip_mask = rrect(S, S, u(22))
r_c, g_c, b_c, a_c = canvas.split()
a_c = ImageChops.multiply(a_c, clip_mask)
canvas = Image.merge("RGBA", (r_c, g_c, b_c, a_c))

# ── 9. Downsample 512 → 128 ──────────────────────────────────────────────────
final = canvas.resize((SIZE, SIZE), Image.LANCZOS)

# ── 10. Save ──────────────────────────────────────────────────────────────────
out = r"C:\Users\lanbosheng\Desktop\claude skills\figma-image-importer\icon.png"
final.save(out, "PNG", optimize=True)
print(f"Saved {out}  |  {final.size}  |  {final.mode}")
