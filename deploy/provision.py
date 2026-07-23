#!/usr/bin/env python3
"""
Provisiona a infra do backend do Gauntlet no AWS Lightsail. Roda UMA vez.

O que ele cria/garante, tudo em sa-east-1 (Sao Paulo):
  - um par de chaves SSH proprio ('gauntlet-key'); a chave privada e salva em
    deploy/lightsail_key.pem (so aparece uma vez, na criacao)
  - um IP estatico (gratis enquanto anexado a uma instancia)
  - uma instancia Lightsail de 1 GB rodando Ubuntu, que no PRIMEIRO BOOT se
    auto-configura via cloud-init (instala Java 21 + cria o servico systemd
    'gauntlet'). Voce nunca precisa entrar na maquina pra instalar nada.
  - abre a porta 8080 no firewall da instancia (a 22/SSH ja vem aberta)

E idempotente: rodar de novo nao duplica nada, so completa o que faltar.
Ao final, grava deploy/instance.json com o IP. Depois use deploy.py.

Requer:  pip install boto3
(as credenciais vem do teu ~/.aws, o mesmo arquivo que a CLI ja usa)
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import boto3

REGION = "sa-east-1"
INSTANCE_NAME = "gauntlet-server"
STATIC_IP_NAME = "gauntlet-ip"
KEY_PAIR_NAME = "gauntlet-key"
APP_PORT = 8080

HERE = Path(__file__).resolve().parent
KEY_PATH = HERE / "lightsail_key.pem"
INSTANCE_INFO = HERE / "instance.json"

# Script que roda como root no primeiro boot (cloud-init). Instala o JRE 21 e
# registra o servico systemd. NAO da 'start' aqui porque o app.jar ainda nao
# existe - o primeiro deploy.py sobe o jar e inicia.
#
# WorkingDirectory=/opt/gauntlet e ESSENCIAL: o H2 grava ./data/gauntlet.mv.db
# relativo ao cwd do processo, entao o banco fica sempre em /opt/gauntlet/data
# e sobrevive aos deploys (que so trocam o app.jar, nunca a pasta data/).
LAUNCH_SCRIPT = """#!/bin/bash
set -e
apt-get update
apt-get install -y openjdk-21-jre-headless
mkdir -p /opt/gauntlet/data
chown -R ubuntu:ubuntu /opt/gauntlet
cat > /etc/systemd/system/gauntlet.service <<'UNIT'
[Unit]
Description=Gauntlet Spring Boot server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/gauntlet
ExecStart=/usr/bin/java -Xmx512m -jar /opt/gauntlet/app.jar
SuccessExitStatus=143
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable gauntlet
"""


def set_key_acl():
    # OpenSSH no Windows recusa a chave privada se o ACL for permissivo demais.
    # Remove heranca e da leitura so pro usuario atual.
    user = os.environ.get("USERNAME") or os.getlogin()
    subprocess.run(["icacls", str(KEY_PATH), "/inheritance:r"], check=False)
    subprocess.run(["icacls", str(KEY_PATH), "/grant:r", f"{user}:R"], check=False)


def ensure_key_pair(client):
    names = {k["name"] for k in client.get_key_pairs()["keyPairs"]}
    if KEY_PAIR_NAME in names:
        if not KEY_PATH.exists():
            sys.exit(
                f"O key pair '{KEY_PAIR_NAME}' ja existe na AWS, mas o arquivo "
                f"{KEY_PATH.name} sumiu. A chave privada so e mostrada na criacao "
                f"e nao da pra recuperar. Delete o key pair no console do Lightsail "
                f"e rode de novo."
            )
        print(f"Key pair '{KEY_PAIR_NAME}' ja existe.")
        return
    res = client.create_key_pair(keyPairName=KEY_PAIR_NAME)
    KEY_PATH.write_text(res["privateKeyBase64"])
    set_key_acl()
    print(f"Key pair criado; chave privada salva em {KEY_PATH.name} (NAO commitar).")


def ensure_static_ip(client):
    existing = {ip["name"] for ip in client.get_static_ips()["staticIps"]}
    if STATIC_IP_NAME not in existing:
        client.allocate_static_ip(staticIpName=STATIC_IP_NAME)
        print(f"IP estatico '{STATIC_IP_NAME}' alocado.")
    else:
        print(f"IP estatico '{STATIC_IP_NAME}' ja existe.")


def pick_blueprint(client):
    # OBS: o campo 'group' do Ubuntu e 'ubuntu_24'/'ubuntu_22', nao 'ubuntu' -
    # por isso casamos pelo blueprintId, que e 'ubuntu_24_04'/'ubuntu_22_04'.
    bps = client.get_blueprints()["blueprints"]
    ubuntu = [b for b in bps
              if b.get("platform") == "LINUX_UNIX" and b.get("type") == "os"
              and b.get("isActive")
              and b.get("blueprintId", "").startswith("ubuntu_")]
    if not ubuntu:
        sys.exit("Nenhum blueprint Ubuntu ativo encontrado na regiao.")
    for b in ubuntu:
        if b["blueprintId"] == "ubuntu_24_04":
            return b["blueprintId"]
    return ubuntu[-1]["blueprintId"]


def pick_bundle(client):
    # Descarta os bundles 'ipv6' (IPv6-only, mais baratos mas sem IPv4 publico:
    # o IP estatico IPv4 nao anexa e o SSH so ia por IPv6). Queremos dual-stack.
    bundles = client.get_bundles()["bundles"]
    one_gb = [b for b in bundles
              if b.get("ramSizeInGb") == 1.0 and b.get("isActive")
              and "LINUX_UNIX" in b.get("supportedPlatforms", [])
              and "ipv6" not in b.get("bundleId", "")]
    if not one_gb:
        sys.exit("Nenhum bundle Linux de 1 GB com IPv4 encontrado na regiao.")
    one_gb.sort(key=lambda b: b["price"])  # o mais barato dos de 1 GB dual-stack
    return one_gb[0]["bundleId"]


def instance_exists(client):
    try:
        client.get_instance(instanceName=INSTANCE_NAME)
        return True
    except client.exceptions.NotFoundException:
        return False


def create_instance(client):
    blueprint_id = pick_blueprint(client)
    bundle_id = pick_bundle(client)
    print(f"Criando instancia '{INSTANCE_NAME}' ({bundle_id}, {blueprint_id})...")
    client.create_instances(
        instanceNames=[INSTANCE_NAME],
        availabilityZone=REGION + "a",
        blueprintId=blueprint_id,
        bundleId=bundle_id,
        keyPairName=KEY_PAIR_NAME,
        ipAddressType="dualstack",  # garante IPv4 publico (pro IP estatico e SSH)
        userData=LAUNCH_SCRIPT,
    )


def wait_running(client):
    print("Esperando a instancia ficar 'running'", end="", flush=True)
    while True:
        state = client.get_instance(instanceName=INSTANCE_NAME)["instance"]["state"]["name"]
        if state == "running":
            print(" ok")
            return
        print(".", end="", flush=True)
        time.sleep(5)


def open_app_port(client):
    # 22 (SSH) ja vem aberta por padrao; adicionamos a 8080 do app.
    client.open_instance_public_ports(
        instanceName=INSTANCE_NAME,
        portInfo={"fromPort": APP_PORT, "toPort": APP_PORT, "protocol": "tcp"},
    )
    print(f"Porta {APP_PORT} liberada no firewall da instancia.")


def attach_static_ip(client):
    ip = client.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
    if ip.get("attachedTo") != INSTANCE_NAME:
        client.attach_static_ip(staticIpName=STATIC_IP_NAME, instanceName=INSTANCE_NAME)
        print("IP estatico anexado a instancia.")
    return client.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]["ipAddress"]


def main():
    client = boto3.client("lightsail", region_name=REGION)
    ensure_key_pair(client)
    ensure_static_ip(client)
    if instance_exists(client):
        print(f"Instancia '{INSTANCE_NAME}' ja existe.")
    else:
        create_instance(client)
    wait_running(client)
    open_app_port(client)
    ip = attach_static_ip(client)
    INSTANCE_INFO.write_text(json.dumps({"ip": ip, "user": "ubuntu"}, indent=2))

    print(f"\nPronto. IP estatico: {ip}")
    print("A instancia esta rodando o setup de primeiro boot (instala Java, ~1-2 min).")
    print("Espere ~2 min e rode:  python deploy/deploy.py")


if __name__ == "__main__":
    main()
