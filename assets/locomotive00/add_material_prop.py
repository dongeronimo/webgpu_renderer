# Cria em cada objeto mesh da cena uma custom property "Material" (string).
# Idempotente: nao sobrescreve valor ja preenchido.
import bpy

PROP = "Material"
PREFILL_FROM_MATERIAL = False  # True: preenche com o nome do material ativo do slot
ON_MESH_DATA = False           # True: poe na mesh (object.data) em vez do objeto

created, kept = 0, 0
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    target = o.data if ON_MESH_DATA else o
    if PROP in target.keys():
        kept += 1
        continue
    value = ""
    if PREFILL_FROM_MATERIAL and o.active_material is not None:
        value = o.active_material.name
    target[PROP] = value
    # metadados de UI: garante tipo string editavel no painel
    ui = target.id_properties_ui(PROP)
    ui.update(description="Material da engine (string)", default="")
    created += 1

print("criadas:%d | ja existiam (mantidas):%d" % (created, kept))
