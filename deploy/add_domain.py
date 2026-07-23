#!/usr/bin/env python3
"""
Anexa o dominio proprio (gauntlet.dongeronimo.net) na distribuicao CloudFront
do frontend. Passo NAO-destrutivo: rode depois que a URL *.cloudfront.net ja
estiver funcionando. Roda uma vez (idempotente).

Como o DNS do dongeronimo.net esta no Route53 da propria conta, da pra fazer
tudo por API:
  1. pede/reusa um certificado ACM pro subdominio em us-east-1 (CloudFront so
     aceita cert nessa regiao)
  2. cria o registro CNAME de validacao no Route53 e espera o cert ser emitido
  3. adiciona o subdominio (Aliases) + o cert na distribuicao CloudFront
  4. cria os registros A/AAAA (alias) do subdominio -> CloudFront no Route53

O apex dongeronimo.net fica intacto (e do VR medico antigo, outra distribuicao).
Le dist_id/domain de deploy/frontend.json. Requer: pip install boto3
"""
import json
import sys
import time
from pathlib import Path

import boto3

SUBDOMAIN = "gauntlet.dongeronimo.net"          # troque aqui se quiser outro nome
HOSTED_ZONE_ID = "Z0562979EMUZP1TRRLXE"         # zona do dongeronimo.net (Route53)
CLOUDFRONT_ZONE_ID = "Z2FDTNDATAQYW2"           # zona fixa de TODA distribuicao CloudFront

HERE = Path(__file__).resolve().parent
FRONTEND_INFO = HERE / "frontend.json"


def find_or_request_cert(acm):
    # Reusa um cert existente pro subdominio (evita duplicar em re-runs).
    for c in acm.list_certificates(
            CertificateStatuses=["PENDING_VALIDATION", "ISSUED"])["CertificateSummaryList"]:
        if c["DomainName"] == SUBDOMAIN:
            print(f"Reusando certificado existente ({c['CertificateArn'].split('/')[-1]}).")
            return c["CertificateArn"]
    arn = acm.request_certificate(
        DomainName=SUBDOMAIN,
        ValidationMethod="DNS",
        IdempotencyToken="gauntletcert",
    )["CertificateArn"]
    print("Certificado ACM solicitado.")
    return arn


def dns_validate(acm, r53, cert_arn):
    # Espera o ACM revelar o registro de validacao, cria ele no Route53 e
    # espera o cert ficar ISSUED.
    print("Esperando o registro de validacao do ACM", end="", flush=True)
    while True:
        opts = acm.describe_certificate(
            CertificateArn=cert_arn)["Certificate"].get("DomainValidationOptions", [])
        if opts and opts[0].get("ResourceRecord"):
            rr = opts[0]["ResourceRecord"]
            break
        print(".", end="", flush=True)
        time.sleep(3)
    print(" ok")
    r53.change_resource_record_sets(
        HostedZoneId=HOSTED_ZONE_ID,
        ChangeBatch={"Changes": [{
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": rr["Name"], "Type": rr["Type"], "TTL": 300,
                "ResourceRecords": [{"Value": rr["Value"]}],
            },
        }]},
    )
    print("Registro de validacao criado no Route53. Esperando o cert ser emitido")
    print("(costuma levar 2-5 min)...")
    acm.get_waiter("certificate_validated").wait(CertificateArn=cert_arn)
    print("Certificado ISSUED.")


def attach_to_distribution(cf, dist_id, cert_arn):
    cur = cf.get_distribution_config(Id=dist_id)
    etag, config = cur["ETag"], cur["DistributionConfig"]
    if SUBDOMAIN in config.get("Aliases", {}).get("Items", []):
        print("Subdominio ja esta na distribuicao.")
        return
    config["Aliases"] = {"Quantity": 1, "Items": [SUBDOMAIN]}
    config["ViewerCertificate"] = {
        "ACMCertificateArn": cert_arn,
        "SSLSupportMethod": "sni-only",
        "MinimumProtocolVersion": "TLSv1.2_2021",
    }
    cf.update_distribution(Id=dist_id, IfMatch=etag, DistributionConfig=config)
    print("Subdominio + certificado anexados a distribuicao CloudFront.")


def point_dns(r53, dist_domain):
    # Alias A (IPv4) e AAAA (IPv6) do subdominio -> a distribuicao CloudFront.
    for rtype in ("A", "AAAA"):
        r53.change_resource_record_sets(
            HostedZoneId=HOSTED_ZONE_ID,
            ChangeBatch={"Changes": [{
                "Action": "UPSERT",
                "ResourceRecordSet": {
                    "Name": SUBDOMAIN, "Type": rtype,
                    "AliasTarget": {
                        "HostedZoneId": CLOUDFRONT_ZONE_ID,
                        "DNSName": dist_domain,
                        "EvaluateTargetHealth": False,
                    },
                },
            }]},
        )
    print(f"DNS apontado: {SUBDOMAIN} -> {dist_domain}")


def main():
    if not FRONTEND_INFO.exists():
        sys.exit("deploy/frontend.json nao existe - rode frontend_provision.py primeiro.")
    info = json.loads(FRONTEND_INFO.read_text())
    dist_id, dist_domain = info["distribution_id"], info["domain"]

    acm = boto3.client("acm", region_name="us-east-1")  # obrigatorio p/ CloudFront
    r53 = boto3.client("route53")
    cf = boto3.client("cloudfront")

    cert_arn = find_or_request_cert(acm)
    dns_validate(acm, r53, cert_arn)
    attach_to_distribution(cf, dist_id, cert_arn)
    point_dns(r53, dist_domain)

    print(f"\nPronto. Em alguns minutos: https://{SUBDOMAIN}")
    print("(a distribuicao reprocessa ~5-15 min ao mudar o dominio; o DNS do")
    print(" Route53 propaga rapido)")


if __name__ == "__main__":
    main()
