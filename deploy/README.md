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
             |
       + /volumes/*  <- os exames, subidos à parte de public/volumes
```

O `vr.dongeronimo.net` (`provision_vr.py`) é uma segunda distribuição servindo o
**mesmo bucket**, sem as rotas de backend. As duas enxergam os mesmos exames.

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
python deploy/deploy.py backend            # mudou o server -> rebuilda o .jar + restart
python deploy/deploy.py frontend           # mudou o client -> rebuilda o Vite + S3 + invalidation
python deploy/deploy.py volumes            # exportou exame novo -> sobe os exames
python deploy/deploy.py volumes abd_1mm    # só um exame
python deploy/deploy.py all                # os três
```

O deploy do backend **não** toca em `/opt/gauntlet/data` (o banco H2 em arquivo),
então os dados persistem entre deploys.

## Os exames (`volumes`)

Alvo separado porque o dado é de outra natureza: centenas de MB por exame
(787 MB em 3, e cresce) e **imutável** — uma vez exportado pelo
`dicom_converter.py`, um exame nunca muda.

### Onde eles moram: `public/volumes` é uma JUNCTION

Os arquivos **não estão no repositório**. Moram em `D:\dev\exames` e
`public/volumes` é uma junction do Windows apontando pra lá:

```powershell
New-Item -ItemType Junction -Path .\public\volumes -Target D:\dev\exames
```

Junction e não symlink: `mklink /J` não precisa de admin nem de Developer Mode,
e o Python/Node a enxergam como diretório de verdade (`is_dir()` True,
`is_symlink()` False) — Vite, `aws s3 sync` e o `make_volumes_index.py`
atravessam sem saber que existe.

Por que: os exames ficavam dentro do repo e eram **commitados**. Fora que o
`.git` foi a 540 MB, o dado é imutável e quem o distribui é o S3, não o git.
Agora `public/volumes/` está no `.gitignore`.

**Num clone novo a junction não vem** (git não versiona o alvo dela). Sem ela o
seletor de exames abre vazio com erro de catálogo. Recrie com o comando acima,
apontando pra onde os exames estiverem naquela máquina, e rode
`python make_volumes_index.py`.

- **Não entram no `dist/`.** O `vite.config.ts` pula `public/volumes` na cópia do
  public (`copyPublicDir: false` + plugin próprio). Sem isso o build limpo levava
  11,7 s e o `dist/` ia a 832 MB, duplicando em disco bytes idênticos aos de
  `public/volumes`. Agora: 46 MB.
- **O sync do frontend exclui `volumes/*`.** Não é opcional: como os exames não
  estão mais no `dist/`, sem o exclude o `--delete` apagaria **todos** do bucket.
- **`Cache-Control: max-age=31536000, immutable`** nas fatias. O ganho é no
  browser — quem já abriu o `abd_1mm` (446 MB) não rebaixa nada na 2ª visita.
- **`Content-Type` explícito no sync**, em dois passes (binário e `*.json`).
  Sem ele o CLI adivinha pela extensão e `.raw` vira `image/RAW`. Não quebra o
  loader (o fetch lê `arrayBuffer`), mas o sync decide por tamanho+mtime: o
  arquivo nunca mais seria reenviado pra corrigir o header.
- **`deploy.py volumes --fix-headers`** reescreve `Cache-Control`/`Content-Type`
  do que **já está no bucket**, por cópia server-side
  (`--metadata-directive REPLACE`) — não sobe byte nenhum daqui. Existe porque
  o `sync` sozinho nunca conserta header de objeto que ele considera em dia.
- **`index.json` com `max-age=60`.** É o único arquivo daqui que muda sozinho
  (exportou exame novo → ele entra na lista); com cache longo o exame novo só
  apareceria pra quem limpasse o cache.
- **O `index.json` é regerado antes de subir** (`make_volumes_index.py`). Sem
  isso, exportar um exame e dar deploy sobe as fatias mas não a linha que o põe
  na lista: o exame fica no ar, invisível.
- **Dry-run + confirmação** acima de 50 MB: o sync é incremental, então o script
  mostra quantos arquivos e quantos bytes vão subir de verdade antes de gastar.
- **Exame que sumiu daqui não é apagado do S3** — o script avisa e imprime o
  `aws s3 rm` pra você rodar à mão. É dado de paciente convertido; apagar
  centenas de MB sozinho não é decisão de script.

### Custo, que aqui não é desprezível

Transferência de saída do CloudFront em São Paulo é ~US$ 0,11/GB. **Cada abertura
do `abd_1mm` são 446 MB ≈ US$ 0,05.** Armazenar os 787 MB no S3 é ~US$ 0,03/mês —
o que pesa é o tráfego, não o storage. O `immutable` existe em boa parte por isso:
sem ele, cada revisita repagaria o exame inteiro.

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
  espaço no path). Use `_` ou `-`. Vale pro nome do diretório do exame também:
  ele vira caminho de URL (`/volumes/<dir>`), daí `arterial_tof_sj` e não
  `arterial tof sj`.
- **A distribuição não tem `CustomErrorResponses`**, então arquivo que falta
  devolve 403/404 de verdade em vez de `index.html` com 200. É o oposto do dev
  server do Vite — por isso o `volumeLoader`/`volumeCatalog` conferem o
  `content-type` antes de parsear.
- **WebSocket:** o client deriva `wss://` do `location.protocol`
  (`GauntletNetwork.wsUrl`); não hardcodar `ws://`.

## TODO de segurança (antes de gente real)

- `/h2-console` está exposto na `:8080` sem login — desativar em produção ou
  trancar. Travar a porta só pro CloudFront é chato no Lightsail (sem
  prefix-list); a saída é um header secreto injetado pelo CloudFront e exigido
  pelo Spring.
