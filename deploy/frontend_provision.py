#!/usr/bin/env python3
"""
Provisiona o frontend: bucket S3 privado + distribuicao CloudFront. Roda UMA vez.

O CloudFront faz em producao o papel que o proxy do Vite faz em dev:
  - origem S3 (privada, via OAC): serve o dist/ - index.html, JS, e os assets
    pesados (volumes CT, .glb, texturas). E o comportamento default.
  - origem backend (o Lightsail via seu DNS ec2-...compute.amazonaws.com, HTTP
    na 8080): recebe /ws/*, /api/*, /login, /logout. SEM cache e repassando
    cookies/headers - a sessao do Spring Security depende do cookie, e o
    handshake do WS carrega ele.

Resultado: o frontend continua com URLs relativas, um dominio so, sem CORS.
Comeca no dominio gratis *.cloudfront.net (HTTPS incluso). Dominio proprio e
um passo nao-destrutivo depois (anexa cert ACM em us-east-1 + alternate name).

Le o IP do backend de deploy/instance.json. Requer: pip install boto3
"""
import json
import sys
import time
from pathlib import Path

import boto3

REGION = "sa-east-1"
COMMENT = "gauntlet-frontend"  # identifica a distribuicao (idempotencia)

HERE = Path(__file__).resolve().parent
INSTANCE_INFO = HERE / "instance.json"
FRONTEND_INFO = HERE / "frontend.json"

# IDs de policies gerenciadas pela AWS (estaveis em qualquer conta):
CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"   # cache p/ estatico
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"    # sem cache p/ backend
ALL_VIEWER = "216adef6-5c7f-47e4-b989-5492eafa07d3"          # repassa tudo p/ origem


def backend_behavior(path_pattern, backend_id):
    # Rota dinamica: sem cache, repassa cookies/headers/query pro backend.
    # GET/HEAD cobre o handshake do WS (que e um GET com Upgrade); os demais
    # metodos cobrem os POST de /login e /api.
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
        "OriginRequestPolicyId": ALL_VIEWER,
    }


def ensure_bucket(s3, bucket):
    try:
        s3.create_bucket(
            Bucket=bucket,
            CreateBucketConfiguration={"LocationConstraint": REGION},
        )
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


def create_distribution(cf, bucket, oac_id, backend_dns):
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
                # Avisa o Spring que o request original era HTTPS (o CloudFront
                # termina o TLS e fala HTTP com a origem). Sem isto o redirect
                # pos-login sai http:// e o browser bloqueia (mixed content).
                "CustomHeaders": {"Quantity": 1, "Items": [
                    {"HeaderName": "X-Forwarded-Proto", "HeaderValue": "https"},
                ]},
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
            backend_behavior("/ws/*", backend_id),
            backend_behavior("/api/*", backend_id),
            backend_behavior("/login", backend_id),
            backend_behavior("/logout", backend_id),
        ]},
        "ViewerCertificate": {"CloudFrontDefaultCertificate": True},
    }
    dist = cf.create_distribution(DistributionConfig=config)["Distribution"]
    print("Distribuicao CloudFront criada.")
    return dist["Id"], dist["DomainName"], dist["ARN"]


def attach_bucket_policy(s3, bucket, dist_arn):
    # Deixa SO esta distribuicao CloudFront ler o bucket (que segue privado).
    policy = {
        "Version": "2008-10-17",
        "Statement": [{
            "Sid": "AllowCloudFrontRead",
            "Effect": "Allow",
            "Principal": {"Service": "cloudfront.amazonaws.com"},
            "Action": "s3:GetObject",
            "Resource": f"arn:aws:s3:::{bucket}/*",
            "Condition": {"StringEquals": {"AWS:SourceArn": dist_arn}},
        }],
    }
    s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps(policy))
    print("Policy do bucket aplicada (leitura so pelo CloudFront).")


def main():
    if not INSTANCE_INFO.exists():
        sys.exit("deploy/instance.json nao existe - rode provision.py (backend) primeiro.")
    ip = json.loads(INSTANCE_INFO.read_text())["ip"]
    backend_dns = f"ec2-{ip.replace('.', '-')}.{REGION}.compute.amazonaws.com"

    account = boto3.client("sts").get_caller_identity()["Account"]
    bucket = f"gauntlet-frontend-{account}"

    s3 = boto3.client("s3", region_name=REGION)
    cf = boto3.client("cloudfront")  # CloudFront e global

    ensure_bucket(s3, bucket)
    oac_id = ensure_oac(cf)

    found = find_distribution(cf)
    if found:
        dist_id, domain, arn = found
        print(f"Distribuicao '{COMMENT}' ja existe ({dist_id}).")
    else:
        dist_id, domain, arn = create_distribution(cf, bucket, oac_id, backend_dns)

    attach_bucket_policy(s3, bucket, arn)
    FRONTEND_INFO.write_text(json.dumps(
        {"bucket": bucket, "distribution_id": dist_id, "domain": domain}, indent=2))

    print(f"\nPronto. URL do site (HTTPS): https://{domain}")
    print("A distribuicao leva ~5-15 min pra propagar na 1a vez.")
    print("Agora rode:  python deploy/frontend_deploy.py  (builda e sobe o dist/)")


if __name__ == "__main__":
    main()
