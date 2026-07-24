#!/usr/bin/env python3
"""
Provisiona a distribuição do VR: vr.dongeronimo.net, 100% ESTÁTICA (o VR não
tem backend). Serve o MESMO bundle do S3 que o Gauntlet — é um bundle só,
filtrado por hostname no client (ver src/appConfig.ts). Roda UMA vez.

Faz tudo de uma vez (a pipeline do gauntlet já está provada): cert ACM em
us-east-1 + validação DNS no Route53, distribuição CloudFront estática com o
alias vr.dongeronimo.net, policy do bucket liberando as distribuições da conta,
e o A/AAAA no Route53. Escreve deploy/vr.json.

Idempotente. Requer: pip install boto3
"""
import json
import sys
import time
from pathlib import Path

import boto3

REGION = "sa-east-1"
SUBDOMAIN = "vr.dongeronimo.net"
COMMENT = "vr-frontend"                    # identifica a distribuição (idempotência)
HOSTED_ZONE_ID = "Z0562979EMUZP1TRRLXE"    # zona do dongeronimo.net (Route53)
CLOUDFRONT_ZONE_ID = "Z2FDTNDATAQYW2"      # zona fixa de TODA distribuição CloudFront
OAC_NAME = "gauntlet-oac"                  # reusa o OAC (account-level, serve N distros)
CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"

HERE = Path(__file__).resolve().parent
VR_INFO = HERE / "vr.json"


def ensure_oac(cf):
    lst = cf.list_origin_access_controls().get("OriginAccessControlList", {})
    for item in lst.get("Items", []):
        if item["Name"] == OAC_NAME:
            return item["Id"]
    return cf.create_origin_access_control(OriginAccessControlConfig={
        "Name": OAC_NAME, "Description": "OAC do frontend",
        "OriginAccessControlOriginType": "s3",
        "SigningBehavior": "always", "SigningProtocol": "sigv4",
    })["OriginAccessControl"]["Id"]


def find_or_request_cert(acm):
    for c in acm.list_certificates(
            CertificateStatuses=["PENDING_VALIDATION", "ISSUED"])["CertificateSummaryList"]:
        if c["DomainName"] == SUBDOMAIN:
            print("Reusando certificado existente.")
            return c["CertificateArn"]
    arn = acm.request_certificate(
        DomainName=SUBDOMAIN, ValidationMethod="DNS", IdempotencyToken="vrcert")["CertificateArn"]
    print("Certificado ACM solicitado.")
    return arn


def dns_validate(acm, r53, cert_arn):
    print("Esperando o registro de validação do ACM", end="", flush=True)
    while True:
        opts = acm.describe_certificate(
            CertificateArn=cert_arn)["Certificate"].get("DomainValidationOptions", [])
        if opts and opts[0].get("ResourceRecord"):
            rr = opts[0]["ResourceRecord"]
            break
        print(".", end="", flush=True)
        time.sleep(3)
    print(" ok")
    r53.change_resource_record_sets(HostedZoneId=HOSTED_ZONE_ID, ChangeBatch={"Changes": [{
        "Action": "UPSERT",
        "ResourceRecordSet": {"Name": rr["Name"], "Type": rr["Type"], "TTL": 300,
                              "ResourceRecords": [{"Value": rr["Value"]}]},
    }]})
    print("Registro de validação criado; esperando o cert ser emitido (2-5 min)...")
    acm.get_waiter("certificate_validated").wait(CertificateArn=cert_arn)
    print("Certificado ISSUED.")


def find_distribution(cf):
    for d in cf.list_distributions().get("DistributionList", {}).get("Items", []):
        if d.get("Comment") == COMMENT:
            return d["Id"], d["DomainName"], d["ARN"]
    return None


def create_static_distribution(cf, bucket, oac_id, cert_arn):
    config = {
        "CallerReference": str(time.time()),
        "Comment": COMMENT,
        "Enabled": True,
        "DefaultRootObject": "index.html",
        "HttpVersion": "http2and3",
        "PriceClass": "PriceClass_200",   # inclui a borda de São Paulo (GRU)
        "Aliases": {"Quantity": 1, "Items": [SUBDOMAIN]},
        "Origins": {"Quantity": 1, "Items": [{
            "Id": "s3-frontend",
            "DomainName": f"{bucket}.s3.{REGION}.amazonaws.com",
            "OriginAccessControlId": oac_id,
            "S3OriginConfig": {"OriginAccessIdentity": ""},
        }]},
        "DefaultCacheBehavior": {
            "TargetOriginId": "s3-frontend",
            "ViewerProtocolPolicy": "redirect-to-https",
            "Compress": True,
            "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"],
                               "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
            "CachePolicyId": CACHING_OPTIMIZED,
        },
        "CacheBehaviors": {"Quantity": 0, "Items": []},  # 100% estático, sem backend
        "ViewerCertificate": {
            "ACMCertificateArn": cert_arn,
            "SSLSupportMethod": "sni-only",
            "MinimumProtocolVersion": "TLSv1.2_2021",
        },
    }
    dist = cf.create_distribution(DistributionConfig=config)["Distribution"]
    return dist["Id"], dist["DomainName"], dist["ARN"]


def set_bucket_policy(s3, bucket, account):
    # Libera QUALQUER distribuição CloudFront da conta a ler o bucket (gauntlet
    # E vr servem o mesmo bundle daqui). Idêntica nos dois scripts, então
    # re-rodar qualquer um mantém as duas funcionando.
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


def point_dns(r53, dist_domain):
    for rtype in ("A", "AAAA"):
        r53.change_resource_record_sets(HostedZoneId=HOSTED_ZONE_ID, ChangeBatch={"Changes": [{
            "Action": "UPSERT",
            "ResourceRecordSet": {"Name": SUBDOMAIN, "Type": rtype, "AliasTarget": {
                "HostedZoneId": CLOUDFRONT_ZONE_ID, "DNSName": dist_domain,
                "EvaluateTargetHealth": False}},
        }]})


def main():
    account = boto3.client("sts").get_caller_identity()["Account"]
    bucket = f"gauntlet-frontend-{account}"   # bucket compartilhado (o bundle é um só)

    s3 = boto3.client("s3", region_name=REGION)
    cf = boto3.client("cloudfront")            # global
    acm = boto3.client("acm", region_name="us-east-1")  # obrigatório p/ CloudFront
    r53 = boto3.client("route53")

    oac_id = ensure_oac(cf)
    cert_arn = find_or_request_cert(acm)
    dns_validate(acm, r53, cert_arn)

    found = find_distribution(cf)
    if found:
        dist_id, domain, arn = found
        print(f"Distribuição '{COMMENT}' ja existe ({dist_id}).")
    else:
        dist_id, domain, arn = create_static_distribution(cf, bucket, oac_id, cert_arn)
        print("Distribuição VR criada.")

    set_bucket_policy(s3, bucket, account)
    point_dns(r53, domain)
    VR_INFO.write_text(json.dumps(
        {"bucket": bucket, "distribution_id": dist_id, "domain": domain}, indent=2))

    print(f"\nPronto. https://{SUBDOMAIN}  (propaga ~5-15 min)")
    print("O bundle já está no bucket (compartilhado com o gauntlet) — o VR já serve.")


if __name__ == "__main__":
    main()
