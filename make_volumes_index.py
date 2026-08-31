#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera public/volumes/index.json — o catálogo de exames disponíveis.

Cada volume exportado pelo dicom_converter.py vira um diretório em
public/volumes/ com um metadata.json dentro. Este script varre esses
diretórios e monta a lista que a UI usa pra montar o seletor de exames.

Rode depois de exportar um exame novo:
    python make_volumes_index.py
"""

import io
import json
import sys

# No Windows, stdout redirecionado usa cp1252 e os ✓/⚠ dos prints quebram
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

from pathlib import Path

# Diretório servido pelo Vite. O path que vai no índice é a URL que o
# loadVolumeTexture() recebe, então é relativo a public/, não ao disco.
PUBLIC_DIR = Path(__file__).parent / "public"
VOLUMES_DIR = PUBLIC_DIR / "volumes"
INDEX_FILE = VOLUMES_DIR / "index.json"


def volume_name(metadata: dict, dir_name: str) -> str:
    """
    Rótulo legível do exame: descrição do estudo e da série.

    As duas tags são texto livre digitado no aparelho, então qualquer uma pode
    vir vazia; quando as duas faltam sobra o nome do diretório, que pelo menos
    identifica o volume sem quebrar a lista.
    """
    study = str(metadata.get("studyDescription", "") or "").strip()
    series = str(metadata.get("seriesDescription", "") or "").strip()

    parts = [p for p in (study, series) if p]
    if not parts:
        return dir_name
    if len(parts) == 2 and parts[0] == parts[1]:
        return parts[0]
    return " — ".join(parts)


def build_index() -> list:
    """Lê todo metadata.json sob public/volumes/ e devolve as entradas do catálogo."""
    if not VOLUMES_DIR.is_dir():
        print(f"✗ Diretório não encontrado: {VOLUMES_DIR}")
        sys.exit(1)

    entries = []
    for directory in sorted(VOLUMES_DIR.iterdir()):
        if not directory.is_dir():
            continue

        metadata_file = directory / "metadata.json"
        if not metadata_file.exists():
            print(f"  ⚠  Ignorado (sem metadata.json): {directory.name}")
            continue

        try:
            metadata = json.loads(io.open(metadata_file, encoding="utf-8").read())
        except json.JSONDecodeError as e:
            print(f"  ⚠  Ignorado (metadata.json inválido): {directory.name} — {e}")
            continue

        entries.append({
            "name": volume_name(metadata, directory.name),
            # URL, não caminho de disco: é o que loadVolumeTexture() espera.
            "path": f"/volumes/{directory.name}",
        })

    entries.sort(key=lambda e: e["name"])
    return entries


def main():
    entries = build_index()

    if not entries:
        print("✗ Nenhum volume encontrado em public/volumes/")
        sys.exit(1)

    with io.open(INDEX_FILE, "w", encoding="utf-8", newline="\n") as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"✓ {INDEX_FILE.relative_to(Path(__file__).parent)} — {len(entries)} exames")
    for entry in entries:
        print(f"    {entry['path']:<32} {entry['name']}")


if __name__ == "__main__":
    main()
