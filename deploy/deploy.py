#!/usr/bin/env python3
"""
Caminho feliz pra deploy de mudancas em producao. Roda quantas vezes quiser.

  python deploy/deploy.py backend    # rebuilda o .jar e reinicia o servico
  python deploy/deploy.py frontend   # rebuilda o Vite, sobe pro S3, invalida cache
  python deploy/deploy.py all        # os dois

Backend: mvnw package -> scp app.jar -> systemctl restart. NAO toca em
/opt/gauntlet/data (banco H2), entao os dados persistem entre deploys.
Frontend: npm run build -> aws s3 sync --delete -> invalidation do CloudFront.

Le deploy/instance.json e deploy/frontend.json (escritos pelos provision_*).
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
BACKEND = REPO / "gauntlet_server" / "gauntlet"
DIST = REPO / "dist"
KEY_PATH = HERE / "lightsail_key.pem"
INSTANCE_INFO = HERE / "instance.json"
FRONTEND_INFO = HERE / "frontend.json"
VR_INFO = HERE / "vr.json"
REMOTE_JAR = "/opt/gauntlet/app.jar"


def run(cmd, **kw):
    print(f"> {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True, **kw)


def deploy_backend():
    print("\n=== BACKEND ===")
    if not INSTANCE_INFO.exists():
        sys.exit("deploy/instance.json nao existe - rode provision_backend.py primeiro.")
    info = json.loads(INSTANCE_INFO.read_text())
    host = f'{info["user"]}@{info["ip"]}'

    # build (mvnw.cmd e .bat -> via 'cmd /c'; testes rodam no dev local).
    # Caminho COMPLETO do mvnw.cmd: alguns Windows não buscam no cwd
    # (NoDefaultCurrentDirectoryInExePath), então 'mvnw.cmd' cru não é achado.
    run(["cmd", "/c", str(BACKEND / "mvnw.cmd"), "clean", "package", "-DskipTests"], cwd=BACKEND)
    jars = [j for j in (BACKEND / "target").glob("*.jar")
            if not j.name.endswith("-plain.jar")]
    if not jars:
        sys.exit("Nenhum .jar em target/ - o build falhou?")
    jar = max(jars, key=lambda j: j.stat().st_mtime)
    print(f"Jar: {jar.name}")

    ssh_opts = ["-i", str(KEY_PATH), "-o", "StrictHostKeyChecking=accept-new"]
    run(["scp", *ssh_opts, str(jar), f"{host}:{REMOTE_JAR}"])
    run(["ssh", *ssh_opts, host, "sudo systemctl restart gauntlet"])
    print(f"Backend ok.  Logs: ssh -i {KEY_PATH.name} {host} \"journalctl -u gauntlet -f\"")


def deploy_frontend():
    print("\n=== FRONTEND ===")
    if not FRONTEND_INFO.exists():
        sys.exit("deploy/frontend.json nao existe - rode provision_frontend.py primeiro.")
    info = json.loads(FRONTEND_INFO.read_text())

    run(["cmd", "/c", "npm", "run", "build"], cwd=REPO)
    if not DIST.exists():
        sys.exit("dist/ nao foi gerado - o build falhou?")
    run(["aws", "s3", "sync", str(DIST), f"s3://{info['bucket']}", "--delete"])

    # invalida TODAS as distribuições que servem o bundle (gauntlet + vr, que
    # compartilham o bucket). vr.json só existe se o VR já foi provisionado.
    dists = [info]
    if VR_INFO.exists():
        dists.append(json.loads(VR_INFO.read_text()))
    for d in dists:
        run(["aws", "cloudfront", "create-invalidation",
             "--distribution-id", d["distribution_id"], "--paths", "/*"])
        print(f"  invalidado: https://{d['domain']}")
    print("Frontend ok.")


TARGETS = {
    "backend": [deploy_backend],
    "frontend": [deploy_frontend],
    "all": [deploy_backend, deploy_frontend],
}


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else None
    if target not in TARGETS:
        sys.exit("uso: python deploy/deploy.py [backend|frontend|all]")
    for fn in TARGETS[target]:
        fn()


if __name__ == "__main__":
    main()
