#!/usr/bin/env python3
"""
Monta o Caddy na VM do Lightsail: TLS automático (Let's Encrypt) em
api.dongeronimo.net, fazendo reverse-proxy pro Spring (localhost:8080). É a
FUNDAÇÃO da etapa 1 — o WS/api/login vão passar a ir DIRETO aqui (~30ms) em vez
de desviar pelo CloudFront (~250ms). Roda UMA vez (idempotente).

Faz:
  1. Route53: A record api.dongeronimo.net -> IP estático da VM.
  2. Lightsail: abre as portas 80 (desafio HTTP do Let's Encrypt) e 443 (WSS).
  3. SSH: instala o Caddy (repo oficial), grava o Caddyfile e sobe o serviço.

Ordem importa: DNS e firewall ANTES do Caddy, senão a emissão do cert falha (o
Let's Encrypt precisa resolver o domínio e bater na porta 80).

Le o IP de deploy/instance.json e usa deploy/lightsail_key.pem. Requer boto3.
"""
import json
import subprocess
import sys
from pathlib import Path

import boto3

REGION = "sa-east-1"
INSTANCE_NAME = "gauntlet-server"
SUBDOMAIN = "api.dongeronimo.net"
HOSTED_ZONE_ID = "Z0562979EMUZP1TRRLXE"

HERE = Path(__file__).resolve().parent
KEY_PATH = HERE / "lightsail_key.pem"
INSTANCE_INFO = HERE / "instance.json"
CADDYFILE = HERE / "Caddyfile"

# Roda na VM (via ssh, sudo sem senha). Idempotente: só instala o Caddy se
# faltar; sempre atualiza o Caddyfile e recarrega.
INSTALL = """set -e
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
fi
sudo mv /tmp/Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy
echo "--- caddy status ---"
sudo systemctl is-active caddy
"""


def run(cmd, **kw):
    print(f"> {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True, **kw)


def main():
    if not INSTANCE_INFO.exists():
        sys.exit("deploy/instance.json nao existe - rode provision_backend.py primeiro.")
    ip = json.loads(INSTANCE_INFO.read_text())["ip"]

    r53 = boto3.client("route53")
    ls = boto3.client("lightsail", region_name=REGION)

    # 1. DNS: A record do subdominio -> IP da VM
    r53.change_resource_record_sets(HostedZoneId=HOSTED_ZONE_ID, ChangeBatch={"Changes": [{
        "Action": "UPSERT",
        "ResourceRecordSet": {"Name": SUBDOMAIN, "Type": "A", "TTL": 300,
                              "ResourceRecords": [{"Value": ip}]},
    }]})
    print(f"DNS: {SUBDOMAIN} -> {ip}")

    # 2. firewall: 80 (desafio Let's Encrypt) e 443 (HTTPS/WSS)
    for port in (80, 443):
        ls.open_instance_public_ports(instanceName=INSTANCE_NAME,
            portInfo={"fromPort": port, "toPort": port, "protocol": "tcp"})
    print("Portas 80 e 443 abertas no firewall da instancia.")

    # 3. Caddy: scp do Caddyfile + instala/configura via ssh
    ssh_opts = ["-i", str(KEY_PATH), "-o", "StrictHostKeyChecking=accept-new"]
    run(["scp", *ssh_opts, str(CADDYFILE), f"ubuntu@{ip}:/tmp/Caddyfile"])
    print("Instalando/configurando o Caddy na VM (pode levar ~1 min na 1a vez)...")
    run(["ssh", *ssh_opts, f"ubuntu@{ip}", "bash -s"], input=INSTALL.encode())

    print(f"\nCaddy montado. O cert Let's Encrypt e emitido no 1o acesso (~10-30s).")
    print(f"Teste:  curl.exe -i https://{SUBDOMAIN}/   (deve vir o form de login do Spring, via TLS)")


if __name__ == "__main__":
    main()
