# Dump de diagnostico das pecas railroad-*: bbox, portas calculadas,
# vizinhos mais proximos de cada porta, duplicatas e pecas escondidas.
# Escreve track_ports_report.txt ao lado do .blend.
import bpy
from mathutils import Vector

OUT = bpy.path.abspath("//track_ports_report.txt")
KAPPA = 0.5522847498


def bbox_xy(o):
    bb = [Vector(c) for c in o.bound_box]
    xs = [v.x for v in bb]
    ys = [v.y for v in bb]
    zs = [v.z for v in bb]
    return min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)


def fmt(v):
    return "(%.3f, %.3f, %.3f)" % (v.x, v.y, v.z)


def ports_straight(o):
    xmin, xmax, ymin, ymax, _, _ = bbox_xy(o)
    cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
    if (xmax - xmin) >= (ymax - ymin):
        a, b = Vector((xmin, cy, 0)), Vector((xmax, cy, 0))
    else:
        a, b = Vector((cx, ymin, 0)), Vector((cx, ymax, 0))
    mw = o.matrix_world
    return [mw @ a, mw @ b], "eixo longo local %s" % ("X" if (xmax - xmin) >= (ymax - ymin) else "Y")


def ports_corner(o):
    xmin, xmax, ymin, ymax, _, _ = bbox_xy(o)
    cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
    planes = [('x', xmin), ('x', xmax), ('y', ymin), ('y', ymax)]
    entry_ax, entry_co = min(planes, key=lambda p: abs(p[1]))
    other = [p for p in planes if p[0] != entry_ax]
    exit_ax, exit_co = max(other, key=lambda p: abs(p[1]))
    R = abs(exit_co)
    ax = {'x': Vector((1, 0, 0)), 'y': Vector((0, 1, 0))}
    c_of = {'x': cx, 'y': cy}
    t0 = ax[entry_ax] if c_of[entry_ax] > entry_co else -ax[entry_ax]
    t1 = ax[exit_ax] if exit_co > c_of[exit_ax] else -ax[exit_ax]
    E0 = Vector((0, 0, 0))
    E1 = t0 * R + t1 * R
    mw = o.matrix_world
    info = ("entrada=%s%+.3f saida=%s%+.3f R=%.3f t0=%s t1=%s"
            % (entry_ax, entry_co, exit_ax, exit_co, R, fmt(t0), fmt(t1)))
    return [mw @ E0, mw @ E1], info


lines = []
objs = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith("railroad")]
objs.sort(key=lambda o: o.name)

lines.append("== PECAS (%d) ==" % len(objs))
ports = []  # (tile, world_pos)
for o in objs:
    xmin, xmax, ymin, ymax, zmin, zmax = bbox_xy(o)
    kind = "corner" if "corner" in o.name else ("straight" if "straight" in o.name else "???")
    hidden = o.hide_get() or o.hide_viewport
    lines.append("%s  [%s]%s" % (o.name, kind, "  ESCONDIDA!" if hidden else ""))
    lines.append("  mesh=%s  origem_world=%s  escala=%s" %
                 (o.data.name, fmt(o.matrix_world.translation), fmt(o.scale)))
    lines.append("  bbox_local x[%.3f, %.3f] y[%.3f, %.3f] z[%.3f, %.3f]" %
                 (xmin, xmax, ymin, ymax, zmin, zmax))
    if kind == "corner":
        pts, info = ports_corner(o)
        lines.append("  corner: %s" % info)
    elif kind == "straight":
        pts, info = ports_straight(o)
        lines.append("  straight: %s" % info)
    else:
        pts = []
    for k, p in enumerate(pts):
        lines.append("  porta%d_world=%s" % (k, fmt(p)))
        ports.append((o.name, p))

lines.append("")
lines.append("== VIZINHOS DE CADA PORTA (3 mais proximos de outra peca) ==")
for i, (tile, p) in enumerate(ports):
    ds = []
    for j, (t2, q) in enumerate(ports):
        if t2 == tile:
            continue
        ds.append(((q - p).length, j, t2))
    ds.sort(key=lambda x: x[0])
    top = ds[:3]
    # mutuo com o 1o vizinho?
    d0, j0, t0 = top[0]
    back = min(((ports[i2][1] - ports[j0][1]).length, i2)
               for i2 in range(len(ports)) if ports[i2][0] != t0)
    mutual = (back[1] == i)
    lines.append("%s porta%d: %s" % (tile, i % 2 if True else 0, "MUTUO" if mutual else "nao-mutuo"))
    for d, j, t2 in top:
        lines.append("    -> %s  d=%.4f" % (t2, d))

lines.append("")
lines.append("== ORIGENS COINCIDENTES (possiveis duplicatas empilhadas) ==")
found = False
for i, a in enumerate(objs):
    for b in objs[i + 1:]:
        d = (a.matrix_world.translation - b.matrix_world.translation).length
        if d < 0.01:
            lines.append("%s <-> %s  d=%.5f" % (a.name, b.name, d))
            found = True
if not found:
    lines.append("nenhuma")

with open(OUT, "w") as f:
    f.write("\n".join(lines))
print("relatorio escrito em: %s (%d pecas, %d portas)" % (OUT, len(objs), len(ports)))
