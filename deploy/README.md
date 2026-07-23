# Deploy — Gauntlet na AWS (sa-east-1)

**CloudFront** na frente serve o frontend estático do **S3** e faz proxy de
`/ws /api /login /logout` pro **backend Spring Boot** no **Lightsail** — o mesmo
papel que o proxy do Vite faz em dev. Um domínio só, HTTPS, sem CORS.

```
              CloudFront (https://gauntlet.dongeronimo.net)
               /                                    \
      default /*                          /ws /api /login /logout
             |                                        |
         S3 (dist/)                        Lightsail :8080 (Spring Boot + H2)
```

## Pré-requisitos

- AWS CLI configurada (`aws sts get-caller-identity` responde)
- `pip install boto3`

## Setup (uma vez)

```powershell
python deploy/provision_backend.py    # cria a VM Lightsail (instala Java 21 + systemd no 1o boot)
python deploy/deploy.py backend       # sobe o .jar pela 1a vez
python deploy/provision_frontend.py   # cria bucket S3 privado + distribuicao CloudFront
python deploy/deploy.py frontend      # builda e sobe o site
python deploy/add_domain.py           # (opcional) pluga gauntlet.dongeronimo.net (ACM + Route53)
```

## Deploy de mudanças (o dia a dia)

```powershell
python deploy/deploy.py backend    # mudou o server  -> rebuilda o .jar + restart
python deploy/deploy.py frontend   # mudou o client  -> rebuilda o Vite + S3 + invalidation
python deploy/deploy.py all        # os dois
```

O deploy do backend **não** toca em `/opt/gauntlet/data` (o banco H2 em arquivo),
então os dados persistem entre deploys.

## Arquivos locais (gitignored)

| arquivo | o quê |
|---|---|
| `lightsail_key.pem` | chave SSH da VM (**segredo**) |
| `instance.json` | IP do backend |
| `frontend.json` | bucket + id da distribuição CloudFront |

## Pegadinhas já resolvidas (não reabrir)

- **HTTPS atrás do CloudFront:** o backend precisa de
  `server.forward-headers-strategy=native` +
  `server.tomcat.remoteip.protocol-header=CloudFront-Forwarded-Proto` (já no
  `application.properties`). A origin request policy `gauntlet-backend-orp`
  repassa esse header. Sem isso o login redireciona `http://` e o browser
  bloqueia (mixed content). `X-Forwarded-Proto` **não** funciona pelo CloudFront.
- **Nome de asset com `+` ou espaço** quebra no S3/CloudFront (403 — o `+` vira
  espaço no path). Use `_` ou `-`.
- **WebSocket:** o client deriva `wss://` do `location.protocol`
  (`GauntletNetwork.wsUrl`); não hardcodar `ws://`.

## TODO de segurança (antes de gente real)

- `/h2-console` está exposto na `:8080` sem login — desativar em produção ou
  trancar. Travar a porta só pro CloudFront é chato no Lightsail (sem
  prefix-list); a saída é um header secreto injetado pelo CloudFront e exigido
  pelo Spring.
