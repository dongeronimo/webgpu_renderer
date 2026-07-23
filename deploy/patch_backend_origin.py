#!/usr/bin/env python3
"""
Injeta o header 'X-Forwarded-Proto: https' na origem backend da distribuicao
CloudFront JA existente. Correcao pontual do mixed-content no login: sem ele o
Spring (que recebe HTTP da borda) monta o redirect pos-login como http:// e o
browser bloqueia numa pagina https.

Idempotente. Requer que o backend tenha server.forward-headers-strategy=framework
(no application.properties) pra honrar o header. Le deploy/frontend.json.
"""
import json
import sys
from pathlib import Path

import boto3

HEADER = {"HeaderName": "X-Forwarded-Proto", "HeaderValue": "https"}
HERE = Path(__file__).resolve().parent
FRONTEND_INFO = HERE / "frontend.json"


def main():
    if not FRONTEND_INFO.exists():
        sys.exit("deploy/frontend.json nao existe - rode frontend_provision.py primeiro.")
    dist_id = json.loads(FRONTEND_INFO.read_text())["distribution_id"]

    cf = boto3.client("cloudfront")
    cur = cf.get_distribution_config(Id=dist_id)
    etag, config = cur["ETag"], cur["DistributionConfig"]

    backend = next((o for o in config["Origins"]["Items"] if o["Id"] == "backend"), None)
    if backend is None:
        sys.exit("Origem 'backend' nao encontrada na distribuicao.")

    items = backend.get("CustomHeaders", {}).get("Items", [])
    if any(h["HeaderName"].lower() == "x-forwarded-proto" for h in items):
        print("Header X-Forwarded-Proto ja esta na origem backend. Nada a fazer.")
        return
    items.append(HEADER)
    backend["CustomHeaders"] = {"Quantity": len(items), "Items": items}

    cf.update_distribution(Id=dist_id, IfMatch=etag, DistributionConfig=config)
    print("Header 'X-Forwarded-Proto: https' adicionado a origem backend.")
    print("A distribuicao reprocessa ~5-15 min. Depois teste o login de novo.")


if __name__ == "__main__":
    main()
