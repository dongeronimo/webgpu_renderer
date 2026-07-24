#!/usr/bin/env python3
"""
Provisiona o frontend: bucket S3 privado + distribuicao CloudFront. Roda UMA vez.

O CloudFront faz em producao o papel do proxy do Vite:
  - origem S3 (privada, via OAC): serve o dist/ - index.html, JS, e os assets
    pesados (volumes CT, .glb, texturas). Comportamento default, com cache.
  - origem backend (Lightsail via DNS ec2-...compute.amazonaws.com, HTTP na
    8080): recebe /ws/*, /api/*, /login, /logout. SEM cache e com a origin
    request policy custom 'gauntlet-backend-orp', que repassa todo o viewer
    (cookies, Host, headers do WebSocket) MAIS o header CloudFront-Forwarded-
    Proto. Esse header e como o Spring descobre que o request original era
    https (o CloudFront termina o TLS e fala HTTP com a origem); sem ele o
    login redireciona http:// e o browser bloqueia como mixed content. O
    backend le esse header via server.forward-headers-strategy=native +
    server.tomcat.remoteip.protocol-header=CloudFront-Forwarded-Proto.

Comeca no dominio *.cloudfront.net; use add_domain.py pro dominio proprio.
Le o IP do backend de deploy/instance.json. Requer: pip install boto3
"""
import json
import sys
import time
from pathlib import Path

import boto3

REGION = "sa-east-1"
COMMENT = "gauntlet-frontend"        # identifica a distribuicao (idempotencia)
BACKEND_POLICY_NAME = "gauntlet-backend-orp"

HERE = Path(__file__).resolve().parent
INSTANCE_INFO = HERE / "instance.json"
FRONTEND_INFO = HERE / "frontend.json"

# Policies gerenciadas pela AWS (IDs estaveis em qualquer conta):
CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"   # cache p/ estatico
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"    # sem cache p/ backend


def ensure_backend_policy(cf):
    # Origin request policy custom: repassa TODO o viewer + o CloudFront-
    # Forwarded-Proto (que o proprio CloudFront adiciona refletindo o protocolo
    # do viewer). Nao da pra usar X-Forwarded-Proto: o CloudFront nao entrega
    # esse nome nem como custom origin header nem via Function.
    lst = cf.list_origin_request_policies(Type="custom")["OriginRequestPolicyList"]
    for item in lst.get("Items", []):
        if item["OriginRequestPolicy"]["OriginRequestPolicyConfig"]["Name"] == BACKEND_POLICY_NAME:
            print("Origin request policy do backend ja existe.")
            return item["OriginRequestPolicy"]["Id"]
    cfg = {
        "Name": BACKEND_POLICY_NAME,
        "Comment": "repassa tudo do viewer + CloudFront-Forwarded-Proto (p/ o Spring saber que e https)",
        "CookiesConfig": {"CookieBehavior": "all"},
        "QueryStringsConfig": {"QueryStringBehavior": "all"},
        "HeadersConfig": {
            "HeaderBehavior": "allViewerAndWhitelistCloudFront",
            "Headers": {"Quantity": 1, "Items": ["CloudFront-Forwarded-Proto"]},
        },
    }
    pid = cf.create_origin_request_policy(
        OriginRequestPolicyConfig=cfg)["OriginRequestPolicy"]["Id"]
    print("Origin request policy do backend criada.")
    return pid


def backend_behavior(path_pattern, backend_id, orp_id):
    # Rota dinamica: sem cache, repassa cookies/headers/query via a ORP custom.
    # GET/HEAD cobre o handshake do WS; os demais metodos cobrem POST de /login e /api.
    return {
        "PathPattern": path_pattern,
        "TargetOriginId": backend_id,
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": False,
        "AllowedMethods": {
            "Quantity": 7,
            "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
            "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
        },
        "CachePolicyId": CACHING_DISABLED,
        "OriginRequestPolicyId": orp_id,
    }


def ensure_bucket(s3, bucket):
    try:
        s3.create_bucket(Bucket=bucket,
                         CreateBucketConfiguration={"LocationConstraint": REGION})
        print(f"Bucket '{bucket}' criado.")
    except s3.exceptions.BucketAlreadyOwnedByYou:
        print(f"Bucket '{bucket}' ja existe.")


def ensure_oac(cf):
    name = "gauntlet-oac"
    existing = cf.list_origin_access_controls().get("OriginAccessControlList", {})
    for item in existing.get("Items", []):
        if item["Name"] == name:
            print("OAC ja existe.")
            return item["Id"]
    oac = cf.create_origin_access_control(OriginAccessControlConfig={
        "Name": name,
        "Description": "OAC do frontend do Gauntlet",
        "OriginAccessControlOriginType": "s3",
        "SigningBehavior": "always",
        "SigningProtocol": "sigv4",
    })["OriginAccessControl"]
    print("OAC criado.")
    return oac["Id"]


def find_distribution(cf):
    dists = cf.list_distributions().get("DistributionList", {})
    for d in dists.get("Items", []):
        if d.get("Comment") == COMMENT:
            return d["Id"], d["DomainName"], d["ARN"]
    return None


def create_distribution(cf, bucket, oac_id, backend_dns, orp_id):
    s3_id, backend_id = "s3-frontend", "backend"
    config = {
        "CallerReference": str(time.time()),
        "Comment": COMMENT,
        "Enabled": True,
        "DefaultRootObject": "index.html",
        "HttpVersion": "http2and3",
        # PriceClass_200 inclui a borda de Sao Paulo (GRU) e e mais barato que _All.
        "PriceClass": "PriceClass_200",
        "Origins": {"Quantity": 2, "Items": [
            {
                "Id": s3_id,
                "DomainName": f"{bucket}.s3.{REGION}.amazonaws.com",
                "OriginAccessControlId": oac_id,
                "S3OriginConfig": {"OriginAccessIdentity": ""},
            },
            {
                "Id": backend_id,
                "DomainName": backend_dns,
                "CustomOriginConfig": {
                    "HTTPPort": 8080,
                    "HTTPSPort": 443,
                    "OriginProtocolPolicy": "http-only",
                    "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
                    "OriginReadTimeout": 60,
                    "OriginKeepaliveTimeout": 5,
                },
            },
        ]},
        "DefaultCacheBehavior": {
            "TargetOriginId": s3_id,
            "ViewerProtocolPolicy": "redirect-to-https",
            "Compress": True,
            "AllowedMethods": {
                "Quantity": 2, "Items": ["GET", "HEAD"],
                "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
            },
            "CachePolicyId": CACHING_OPTIMIZED,
        },
        "CacheBehaviors": {"Quantity": 4, "Items": [
            backend_behavior("/ws/*", backend_id, orp_id),
            backend_behavior("/api/*", backend_id, orp_id),
            backend_behavior("/login", backend_id, orp_id),
            backend_behavior("/logout", backend_id, orp_id),
        ]},
        "ViewerCertificate": {"CloudFrontDefaultCertificate": True},
    }
    dist = cf.create_distribution(DistributionConfig=config)["Distribution"]
    print("Distribuicao CloudFront criada.")
    return dist["Id"], dist["DomainName"], dist["ARN"]


def attach_bucket_policy(s3, bucket, dist_arn):
    # Libera QUALQUER distribuição CloudFront da conta (gauntlet E vr servem o
    # mesmo bundle daqui) — MESMA policy do provision_vr.py, então re-rodar
    # qualquer um dos dois mantém as duas distribuições funcionando.
    account = dist_arn.split(":")[4]
    policy = {
        "Version": "2008-10-17",
        "Statement": [{
            "Sid": "AllowCloudFrontRead",
            "Effect": "Allow",
            "Principal": {"Service": "cloudfront.amazonaws.com"},
            "Action": "s3:GetObject",
            "Resource": f"arn:aws:s3:::{bucket}/*",
            "Condition": {"ArnLike": {
                "AWS:SourceArn": f"arn:aws:cloudfront::{account}:distribution/*"}},
        }],
    }
    s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps(policy))
    print("Policy do bucket aplicada (leitura só pelas distribuições da conta).")


def main():
    if not INSTANCE_INFO.exists():
        sys.exit("deploy/instance.json nao existe - rode provision_backend.py primeiro.")
    ip = json.loads(INSTANCE_INFO.read_text())["ip"]
    backend_dns = f"ec2-{ip.replace('.', '-')}.{REGION}.compute.amazonaws.com"

    account = boto3.client("sts").get_caller_identity()["Account"]
    bucket = f"gauntlet-frontend-{account}"

    s3 = boto3.client("s3", region_name=REGION)
    cf = boto3.client("cloudfront")  # CloudFront e global

    ensure_bucket(s3, bucket)
    oac_id = ensure_oac(cf)
    orp_id = ensure_backend_policy(cf)

    found = find_distribution(cf)
    if found:
        dist_id, domain, arn = found
        print(f"Distribuicao '{COMMENT}' ja existe ({dist_id}).")
    else:
        dist_id, domain, arn = create_distribution(cf, bucket, oac_id, backend_dns, orp_id)

    attach_bucket_policy(s3, bucket, arn)
    FRONTEND_INFO.write_text(json.dumps(
        {"bucket": bucket, "distribution_id": dist_id, "domain": domain}, indent=2))

    print(f"\nPronto. URL do site (HTTPS): https://{domain}")
    print("A distribuicao leva ~5-15 min pra propagar na 1a vez.")
    print("Agora rode:  python deploy/deploy.py frontend")


if __name__ == "__main__":
    main()
