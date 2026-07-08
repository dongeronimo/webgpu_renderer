"""
Roda dentro do Blender (Text Editor > Run Script / Alt+P).

Para cada mesh da cena cria uma custom property "Material" com valor =
nome do material da mesh (assume 1 material por mesh).

- Se ja existir a custom property "Material", ela e reutilizada (sobrescrita).
- Limpa a chave (e residuos de _RNA_UI) antes de gravar o valor novo.

Custom properties de objeto sao exportadas como node.extras no glTF/glb.

OBS Windows: print() so aparece na System Console (Window > Toggle System
Console). Por isso este script tambem mostra um POPUP com o resultado.
"""

import bpy
import traceback

PROP_NAME = "Material"


def clear_prop(obj, name):
    """Remove a custom property 'name' do objeto, se existir."""
    while name in obj.keys():
        del obj[name]
    rna_ui = obj.get("_RNA_UI")
    if rna_ui is not None and name in rna_ui.keys():
        del rna_ui[name]


def main():
    processed = 0
    skipped = 0
    lines = []

    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue

        mats = obj.data.materials
        if not mats or mats[0] is None:
            msg = f"[SKIP] '{obj.name}' sem material."
            print(msg)
            lines.append(msg)
            skipped += 1
            continue

        material_name = mats[0].name
        clear_prop(obj, PROP_NAME)
        obj[PROP_NAME] = material_name

        msg = f"[OK] '{obj.name}' -> {PROP_NAME} = '{material_name}'"
        print(msg)
        lines.append(msg)
        processed += 1

    summary = f"Concluido. {processed} mesh(es) processada(s), {skipped} pulada(s)."
    print("\n" + summary)
    lines.append("")
    lines.append(summary)
    return lines


def show_popup(lines, title="Set Material Property", icon='INFO'):
    def draw(self, context):
        for line in lines:
            self.layout.label(text=line)
    bpy.context.window_manager.popup_menu(draw, title=title, icon=icon)


# roda direto no nivel do modulo (sem depender de __name__)
try:
    result_lines = main()
    show_popup(result_lines)
except Exception:
    tb = traceback.format_exc()
    print(tb)
    show_popup(tb.splitlines(), title="ERRO", icon='ERROR')
    raise
