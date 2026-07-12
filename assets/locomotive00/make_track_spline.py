# Gera a spline TrackSpline a partir dos tiles railroad-* da cena.
# Meshes do kit sao Y-up locais (altura = menor eixo da bbox); plano do trilho
# = os 2 maiores eixos. Retas: portas nas pontas, segmentos VECTOR.
# Corners: centerline amostrada nos CENTROIDES DOS DORMENTES (ilhas conexas da
# mesh, classificadas por tamanho); dormente e simetrico a centerline, entao o
# centroide dele e um ponto exato dela. Fallback: arco analitico com handles
# KAPPA*R se a classificacao de ilhas falhar.
import bpy
from mathutils import Vector

CURVE_NAME = "TrackSpline"
KAPPA = 0.5522847498  # 4/3*tan(22.5): cubica ~ arco de 90 graus
RAIL_FRAC = 0.50      # ilha com diagonal > 50% da diagonal do tile = trilho
PLATE_FRAC = 0.08     # ilha com diagonal < 8% = plaquinha (descarta)

old = bpy.data.objects.get(CURVE_NAME)
if old:
    bpy.data.objects.remove(old, do_unlink=True)
oldc = bpy.data.curves.get(CURVE_NAME)
if oldc:
    bpy.data.curves.remove(oldc)


def axes_of(o):
    bb = [Vector(c) for c in o.bound_box]
    mn = Vector((min(v[i] for v in bb) for i in range(3)))
    mx = Vector((max(v[i] for v in bb) for i in range(3)))
    ext = [mx[i] - mn[i] for i in range(3)]
    h = ext.index(min(ext))
    plane = [i for i in range(3) if i != h]
    return mn, mx, h, plane


def unit(i, s):
    w = Vector((0.0, 0.0, 0.0))
    w[i] = s
    return w


def mesh_islands(me):
    parent = list(range(len(me.vertices)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for e in me.edges:
        ra, rb = find(e.vertices[0]), find(e.vertices[1])
        if ra != rb:
            parent[ra] = rb
    groups = {}
    for vi in range(len(me.vertices)):
        groups.setdefault(find(vi), []).append(vi)
    return list(groups.values())


# cache por datablock: dormentes do corner em espaco local, ordenados de E0->E1
_corner_cache = {}


def corner_boards_local(me, h, E0, tile_diag):
    key = me.name
    if key in _corner_cache:
        return _corner_cache[key]
    islands = mesh_islands(me)
    boards, n_rail, n_plate = [], 0, 0
    for isl in islands:
        cos = [me.vertices[i].co for i in isl]
        mn = Vector((min(c[k] for c in cos) for k in range(3)))
        mx = Vector((max(c[k] for c in cos) for k in range(3)))
        diag = (mx - mn).length
        if diag > RAIL_FRAC * tile_diag:
            n_rail += 1
        elif diag < PLATE_FRAC * tile_diag:
            n_plate += 1
        else:
            cen = Vector((0.0, 0.0, 0.0))
            for c in cos:
                cen += c
            cen /= len(cos)
            cen[h] = 0.0  # achata na altura do encaixe
            boards.append(cen)
    # ordena por corrente NN a partir do encaixe de entrada
    ordered, rem, cur = [], boards[:], E0.copy()
    while rem:
        nx = min(rem, key=lambda p: (p - cur).length_squared)
        ordered.append(nx)
        rem.remove(nx)
        cur = nx
    print("  [ilhas %s] total:%d trilhos:%d placas:%d dormentes:%d"
          % (me.name, len(islands), n_rail, n_plate, len(ordered)))
    _corner_cache[key] = ordered
    return ordered


# ---- tiles: {name, kind, ports[2] (world), inward[2] (world, p/ corner),
#              hfall[2] (handle analitico fallback), interior (world, port0->port1)}
def build_straight(o):
    mn, mx, h, (u, v) = axes_of(o)
    long_ax = u if (mx[u] - mn[u]) >= (mx[v] - mn[v]) else v
    cross_ax = v if long_ax == u else u
    c = (mn[cross_ax] + mx[cross_ax]) / 2
    pts = []
    for val in (mn[long_ax], mx[long_ax]):
        p = Vector((0.0, 0.0, 0.0))
        p[long_ax] = val
        p[cross_ax] = c
        p[h] = 0.0
        pts.append(p)
    mw = o.matrix_world
    return {'name': o.name, 'kind': 'straight',
            'ports': [mw @ pts[0], mw @ pts[1]],
            'inward': [None, None], 'hfall': [None, None], 'interior': []}


def build_corner(o):
    mn, mx, h, (u, v) = axes_of(o)
    planes = [(u, mn[u]), (u, mx[u]), (v, mn[v]), (v, mx[v])]
    entry_ax, entry_co = min(planes, key=lambda p: abs(p[1]))
    other = [p for p in planes if p[0] != entry_ax]
    exit_ax, exit_co = max(other, key=lambda p: abs(p[1]))
    R = abs(exit_co)
    c_entry = (mn[entry_ax] + mx[entry_ax]) / 2
    c_exit = (mn[exit_ax] + mx[exit_ax]) / 2
    t0 = unit(entry_ax, 1.0 if c_entry > entry_co else -1.0)  # entra: pra dentro
    t1 = unit(exit_ax, 1.0 if exit_co > c_exit else -1.0)     # sai: pra fora
    E0 = Vector((0.0, 0.0, 0.0))
    E1 = t0 * R + t1 * R
    H0 = E0 + t0 * (KAPPA * R)
    H1 = E1 - t1 * (KAPPA * R)
    tile_diag = (mx - mn).length
    boards = corner_boards_local(o.data, h, E0, tile_diag)
    mw = o.matrix_world
    m3 = mw.to_3x3()
    inw0 = (m3 @ t0).normalized()          # tangente pra DENTRO na porta 0
    inw1 = (m3 @ (-t1)).normalized()       # tangente pra DENTRO na porta 1
    return {'name': o.name, 'kind': 'corner',
            'ports': [mw @ E0, mw @ E1],
            'inward': [inw0, inw1],
            'hfall': [mw @ H0, mw @ H1],
            'interior': [mw @ p for p in boards]}


tiles, skipped = [], []
for o in bpy.data.objects:
    if o.type != 'MESH' or not o.name.startswith("railroad"):
        continue
    if "corner" in o.name:
        tiles.append(build_corner(o))
    elif "straight" in o.name:
        tiles.append(build_straight(o))
    else:
        skipped.append(o.name)

ports = []  # {'ti', 'pi', 'pos'}
for ti, t in enumerate(tiles):
    for pi in (0, 1):
        ports.append({'ti': ti, 'pi': pi, 'pos': t['ports'][pi]})


def nearest(i):
    p = ports[i]
    best, bd = None, 1e30
    for j, q in enumerate(ports):
        if q['ti'] == p['ti']:
            continue
        d = (q['pos'] - p['pos']).length
        if d < bd:
            bd, best = d, j
    return best, bd


junctions = []
pair_of = {}
maxd = 0.0
for i in range(len(ports)):
    j, d = nearest(i)
    if j is not None and nearest(j)[0] == i and i < j:
        junctions.append((i, j))
        pair_of[i] = j
        pair_of[j] = i
        maxd = max(maxd, d)
unpaired = sorted({tiles[ports[i]['ti']]['name']
                   for i in range(len(ports)) if i not in pair_of})

jn_by_tile = {}
for k, (i, j) in enumerate(junctions):
    jn_by_tile.setdefault(ports[i]['ti'], []).append(k)
    jn_by_tile.setdefault(ports[j]['ti'], []).append(k)


def oriented_interior(t, exit_pi):
    return t['interior'] if exit_pi == 1 else list(reversed(t['interior']))


# ---- caminha o circuito emitindo pontos ----
# ponto = (co, ltype, lvec, rtype, rvec); tipos: 'VECTOR' | 'AUTO' | 'FREE'
bez = []
cur = 0
prev_j = -1
for _ in range(len(junctions)):
    js = [k for k in jn_by_tile.get(cur, []) if k != prev_j]
    if not js:
        break
    k = js[0]
    i, j = junctions[k]
    pa, pb = (ports[i], ports[j]) if ports[i]['ti'] == cur else (ports[j], ports[i])
    A, B = tiles[pa['ti']], tiles[pb['ti']]
    co = (pa['pos'] + pb['pos']) * 0.5

    # interior de A (do outro porto ate o porto de saida pa)
    inter_A = oriented_interior(A, pa['pi'])
    for q in inter_A:
        bez.append((q, 'AUTO', None, 'AUTO', None))

    # handle esquerdo (lado A, aponta pra dentro de A)
    if A['kind'] == 'straight':
        ltype, lvec = 'VECTOR', None
    elif inter_A:
        d = (co - inter_A[-1]).length
        ltype, lvec = 'FREE', co + A['inward'][pa['pi']] * (d / 3.0)
    else:
        ltype, lvec = 'FREE', A['hfall'][pa['pi']]

    # handle direito (lado B, aponta pra dentro de B)
    if B['kind'] == 'straight':
        rtype, rvec = 'VECTOR', None
    else:
        inter_B = oriented_interior(B, 1 - pb['pi'])  # B sera atravessado saindo pelo outro porto
        if inter_B:
            d = (co - inter_B[0]).length
            rtype, rvec = 'FREE', co + B['inward'][pb['pi']] * (d / 3.0)
        else:
            rtype, rvec = 'FREE', B['hfall'][pb['pi']]

    bez.append((co, ltype, lvec, rtype, rvec))
    prev_j, cur = k, pb['ti']
closed = (cur == 0) and len(junctions) == len(tiles)

if not bez:
    raise RuntimeError("Nenhuma juncao pareada. Nao-pareadas: %s" % unpaired)

cu = bpy.data.curves.new(CURVE_NAME, 'CURVE')
cu.dimensions = '3D'
cu.resolution_u = 24
sp = cu.splines.new('BEZIER')
sp.bezier_points.add(len(bez) - 1)
for bp, (co, lt, lv, rt, rv) in zip(sp.bezier_points, bez):
    bp.co = co
    bp.handle_left_type = lt
    bp.handle_right_type = rt
    if lt == 'FREE':
        bp.handle_left = lv
    if rt == 'FREE':
        bp.handle_right = rv
sp.use_cyclic_u = True
ob = bpy.data.objects.new(CURVE_NAME, cu)
bpy.context.scene.collection.objects.link(ob)

n_str = sum(1 for t in tiles if t['kind'] == 'straight')
n_cor = len(tiles) - n_str
print("retas:%d curvas:%d ignoradas:%s" % (n_str, n_cor, skipped))
print("juncoes:%d/%d | nao-pareadas:%s | folga max encaixe:%.4f"
      % (len(junctions), len(tiles), unpaired, maxd))
print("circuito fechado:%s | pontos bezier:%d" % (closed, len(bez)))
