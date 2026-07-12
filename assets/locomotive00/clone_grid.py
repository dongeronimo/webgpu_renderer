# Cria uma grade N x M de clones INSTANCIADOS (linked duplicates, mesma mesh)
# do objeto ativo. Equivale a Alt+D em grade. Passo da grade = dimensoes do
# objeto no mundo + GAP (folga); GAP=0 deixa os clones encostados.
import bpy
from mathutils import Vector

N, M = 5, 8    # linhas (Y) x colunas (X)
GAP = 0.0      # folga entre clones, em unidades do mundo

src = bpy.context.active_object
if src is None or src.type != 'MESH':
    raise RuntimeError("Selecione o objeto (mesh) a clonar antes de rodar.")

sx = src.dimensions.x + GAP
sy = src.dimensions.y + GAP

col = src.users_collection[0] if src.users_collection else bpy.context.scene.collection
base = src.location.copy()

count = 0
for i in range(N):
    for j in range(M):
        if i == 0 and j == 0:
            continue  # o original ocupa a celula (0,0)
        ob = bpy.data.objects.new("%s.%d.%d" % (src.name, i, j), src.data)
        ob.location = base + Vector((j * sx, i * sy, 0.0))
        ob.rotation_euler = src.rotation_euler
        ob.scale = src.scale
        col.objects.link(ob)
        count += 1

print("%d clones de '%s' | passo: %.3f x %.3f (dim %.3f x %.3f + gap %.2f)"
      % (count, src.name, sx, sy, src.dimensions.x, src.dimensions.y, GAP))
