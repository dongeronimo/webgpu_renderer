#!/usr/bin/env python3
"""
Builda o frontend (Vite) e faz deploy pro S3 + CloudFront. Roda toda vez que
voce muda o frontend.

Passos:
  1. npm run build              -> gera dist/ (index.html + JS + public/ copiado:
                                   volumes, .glb, texturas)
  2. aws s3 sync dist ...       -> sobe so o que mudou (--delete remove orfaos)
  3. cloudfront invalidation    -> forca a borda a buscar a versao nova

Le bucket e distribution_id de deploy/frontend.json (do frontend_provision.py).
Usa a AWS CLI pro sync (que ja lida bem com os ~400 arquivos de volume).
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DIST = REPO / "dist"
FRONTEND_INFO = HERE / "frontend.json"


def run(cmd, **kw):
    print(f"> {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True, **kw)


def main():
    if not FRONTEND_INFO.exists():
        sys.exit("deploy/frontend.json nao existe - rode frontend_provision.py primeiro.")
    info = json.loads(FRONTEND_INFO.read_text())
    bucket, dist_id = info["bucket"], info["distribution_id"]

    # 1. build (npm.cmd via 'cmd /c' no Windows). Roda 'tsc && vite build'.
    run(["cmd", "/c", "npm", "run", "build"], cwd=REPO)
    if not DIST.exists():
        sys.exit("dist/ nao foi gerado - o build falhou?")

    # 2. sync pro S3
    run(["aws", "s3", "sync", str(DIST), f"s3://{bucket}", "--delete"])

    # 3. invalida o cache da borda (o /* conta como 1 path; 1000/mes sao gratis)
    run(["aws", "cloudfront", "create-invalidation",
         "--distribution-id", dist_id, "--paths", "/*"])

    print(f"\nDeploy do frontend ok.  https://{info['domain']}")


if __name__ == "__main__":
    main()
