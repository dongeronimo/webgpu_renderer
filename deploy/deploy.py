#!/usr/bin/env python3
"""
Builda o backend do Gauntlet e faz deploy pro Lightsail. Roda toda vez que
voce muda o backend.

Passos:
  1. mvnw clean package       -> gera o fat jar em target/
  2. scp do jar               -> /opt/gauntlet/app.jar na instancia
  3. sudo systemctl restart   -> reinicia o servico

NAO toca em /opt/gauntlet/data (o banco H2), entao os dados persistem entre
deploys. Le o IP de deploy/instance.json (escrito pelo provision.py).
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
BACKEND = REPO / "gauntlet_server" / "gauntlet"
KEY_PATH = HERE / "lightsail_key.pem"
INSTANCE_INFO = HERE / "instance.json"
REMOTE_JAR = "/opt/gauntlet/app.jar"


def run(cmd, **kw):
    print(f"> {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True, **kw)


def main():
    if not INSTANCE_INFO.exists():
        sys.exit("deploy/instance.json nao existe - rode provision.py primeiro.")
    info = json.loads(INSTANCE_INFO.read_text())
    host = f'{info["user"]}@{info["ip"]}'

    # 1. build. mvnw.cmd e um .bat, entao chamamos via 'cmd /c'. Pulamos os
    # testes no build de deploy (mais rapido; testes rodam no dev local).
    run(["cmd", "/c", "mvnw.cmd", "clean", "package", "-DskipTests"], cwd=BACKEND)

    # 2. acha o fat jar (ignora o -plain.jar, que nao e executavel)
    jars = [j for j in (BACKEND / "target").glob("*.jar")
            if not j.name.endswith("-plain.jar")]
    if not jars:
        sys.exit("Nenhum .jar em target/ - o build falhou?")
    jar = max(jars, key=lambda j: j.stat().st_mtime)
    print(f"Jar: {jar.name}")

    ssh_opts = ["-i", str(KEY_PATH), "-o", "StrictHostKeyChecking=accept-new"]

    # 3. copia o jar e reinicia o servico
    run(["scp", *ssh_opts, str(jar), f"{host}:{REMOTE_JAR}"])
    run(["ssh", *ssh_opts, host, "sudo systemctl restart gauntlet"])

    print("\nDeploy ok.")
    print(f"  Testar:  curl http://{info['ip']}:8080/")
    print(f"  Logs:    ssh -i {KEY_PATH.name} {host} \"journalctl -u gauntlet -f\"")


if __name__ == "__main__":
    main()
