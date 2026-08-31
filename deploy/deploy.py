#!/usr/bin/env python3
"""
Caminho feliz pra deploy de mudancas em producao. Roda quantas vezes quiser.

  python deploy/deploy.py backend            # rebuilda o .jar e reinicia o servico
  python deploy/deploy.py frontend           # rebuilda o Vite, sobe pro S3, invalida cache
  python deploy/deploy.py volumes            # sobe os exames convertidos (public/volumes)
  python deploy/deploy.py volumes abd_1mm    # so um exame
  python deploy/deploy.py volumes --fix-headers   # reescreve Cache-Control do que ja esta la
  python deploy/deploy.py all                # os tres

Backend: mvnw package -> scp app.jar -> systemctl restart. NAO toca em
/opt/gauntlet/data (banco H2), entao os dados persistem entre deploys.
Frontend: npm run build -> aws s3 sync --delete -> invalidation do CloudFront.
Volumes: regenera o index.json -> aws s3 sync por exame -> invalidation.

POR QUE OS VOLUMES SAO UM ALVO SEPARADO: sao centenas de MB por exame (787 MB
em 3) e IMUTAVEIS - uma vez exportado, um exame nunca muda. Nao tem por que
passar por eles a cada mudanca de UI, e nao tem por que o browser rebaixar 450
MB de novo a cada visita. Entao eles nao entram no dist (ver vite.config.ts),
sobem direto de public/volumes com Cache-Control de um ano, e o sync do dist
EXCLUI o prefixo volumes/ - senao o --delete dele apagaria todos os exames do
bucket, ja que nao existem mais no dist.

Le deploy/instance.json e deploy/frontend.json (escritos pelos provision_*).
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
BACKEND = REPO / "gauntlet_server" / "gauntlet"
DIST = REPO / "dist"
VOLUMES = REPO / "public" / "volumes"
INDEX_SCRIPT = REPO / "make_volumes_index.py"
KEY_PATH = HERE / "lightsail_key.pem"
INSTANCE_INFO = HERE / "instance.json"
FRONTEND_INFO = HERE / "frontend.json"
VR_INFO = HERE / "vr.json"
REMOTE_JAR = "/opt/gauntlet/app.jar"

# Prefixo dos exames dentro do bucket. Casa com o `path` do index.json
# ("/volumes/abd_1mm"), que e a URL que o loadVolumeTexture recebe.
VOLUMES_PREFIX = "volumes"
# Um ano + immutable: as fatias de um exame nunca mudam. O ganho e no BROWSER -
# quem ja abriu o abd_1mm (446 MB) nao rebaixa nada na segunda visita.
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
# O index.json e a UNICA coisa aqui que muda sem os arquivos ao redor mudarem
# (exportou exame novo -> ele entra na lista). Cache curto, senao o exame novo
# so aparece pra quem limpar o cache.
INDEX_CACHE = "public, max-age=60"
# Acima disto o deploy de volumes pede confirmacao: e trafego de saida pago e
# demorado, e a primeira subida de um exame e irreversivel do ponto de vista da
# conta (ja gastou).
CONFIRM_ABOVE_BYTES = 50 * 1024 * 1024


def run(cmd, **kw):
    print(f"> {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True, **kw)


def capture(cmd):
    print(f"> {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def human(nbytes):
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024 or unit == "GB":
            return f"{nbytes:.1f} {unit}"
        nbytes /= 1024


def invalidate(paths):
    """Invalida `paths` em TODAS as distribuicoes que servem o bundle (gauntlet
    + vr compartilham o bucket). vr.json so existe se o VR foi provisionado."""
    dists = []
    if FRONTEND_INFO.exists():
        dists.append(json.loads(FRONTEND_INFO.read_text()))
    if VR_INFO.exists():
        dists.append(json.loads(VR_INFO.read_text()))
    for d in dists:
        run(["aws", "cloudfront", "create-invalidation",
             "--distribution-id", d["distribution_id"], "--paths", *paths])
        print(f"  invalidado: https://{d['domain']}")


def deploy_backend():
    print("\n=== BACKEND ===")
    if not INSTANCE_INFO.exists():
        sys.exit("deploy/instance.json nao existe - rode provision_backend.py primeiro.")
    info = json.loads(INSTANCE_INFO.read_text())
    host = f'{info["user"]}@{info["ip"]}'

    # build (mvnw.cmd e .bat -> via 'cmd /c'; testes rodam no dev local).
    # Caminho COMPLETO do mvnw.cmd: alguns Windows não buscam no cwd
    # (NoDefaultCurrentDirectoryInExePath), então 'mvnw.cmd' cru não é achado.
    run(["cmd", "/c", str(BACKEND / "mvnw.cmd"), "clean", "package", "-DskipTests"], cwd=BACKEND)
    jars = [j for j in (BACKEND / "target").glob("*.jar")
            if not j.name.endswith("-plain.jar")]
    if not jars:
        sys.exit("Nenhum .jar em target/ - o build falhou?")
    jar = max(jars, key=lambda j: j.stat().st_mtime)
    print(f"Jar: {jar.name}")

    ssh_opts = ["-i", str(KEY_PATH), "-o", "StrictHostKeyChecking=accept-new"]
    run(["scp", *ssh_opts, str(jar), f"{host}:{REMOTE_JAR}"])
    run(["ssh", *ssh_opts, host, "sudo systemctl restart gauntlet"])
    print(f"Backend ok.  Logs: ssh -i {KEY_PATH.name} {host} \"journalctl -u gauntlet -f\"")


def deploy_frontend():
    print("\n=== FRONTEND ===")
    if not FRONTEND_INFO.exists():
        sys.exit("deploy/frontend.json nao existe - rode provision_frontend.py primeiro.")
    info = json.loads(FRONTEND_INFO.read_text())

    run(["cmd", "/c", "npm", "run", "build"], cwd=REPO)
    if not DIST.exists():
        sys.exit("dist/ nao foi gerado - o build falhou?")

    # --exclude "volumes/*" NAO E OPCIONAL: os exames nao estao no dist (ver
    # vite.config.ts), entao sem isto o --delete os apagaria todos do bucket.
    # O exclude deve valer pros dois lados do sync, inclusive pra decidir o que
    # deletar no destino.
    sync = ["aws", "s3", "sync", str(DIST), f"s3://{info['bucket']}",
            "--delete", "--exclude", f"{VOLUMES_PREFIX}/*"]

    # CINTO DE SEGURANCA. A frase acima ("o exclude vale pros dois lados") e a
    # unica coisa entre um deploy de UI e apagar centenas de MB de exame do
    # bucket. Em vez de confiar nela, confere: dry-run primeiro e aborta se
    # QUALQUER delete tocar o prefixo dos volumes. Custa uma listagem.
    plan = capture(sync + ["--dryrun"])
    doomed = [l.strip() for l in plan.splitlines()
              if l.strip().startswith("(dryrun) delete:") and f"/{VOLUMES_PREFIX}/" in l]
    if doomed:
        print("\n".join(doomed[:10]))
        sys.exit(f"ABORTADO: o sync do dist quer apagar {len(doomed)} objeto(s) em "
                 f"{VOLUMES_PREFIX}/ — o --exclude nao esta protegendo os exames. "
                 f"Nao rode isto sem corrigir; refaca com 'deploy.py volumes' depois.")

    run(sync)

    # /* cobre o app inteiro e conta como UM path de invalidation. Pega os
    # volumes junto, o que e inofensivo: invalidation e cache de BORDA, e o
    # Cache-Control immutable que interessa mora no browser de quem ja baixou.
    invalidate(["/*"])
    print("Frontend ok.")


def volume_dirs(only):
    """Os exames a subir. `only` vazio = todos os que tem metadata.json."""
    if not VOLUMES.is_dir():
        sys.exit(f"{VOLUMES} nao existe - nada a subir.")
    found = sorted(d for d in VOLUMES.iterdir()
                   if d.is_dir() and (d / "metadata.json").exists())
    if not only:
        return found
    by_name = {d.name: d for d in found}
    missing = [n for n in only if n not in by_name]
    if missing:
        sys.exit(f"Exame(s) nao encontrado(s) em public/volumes: {', '.join(missing)}\n"
                 f"Disponiveis: {', '.join(by_name) or '(nenhum)'}")
    return [by_name[n] for n in only]


def sync_preview(local_dir, s3_uri):
    """--dryrun antes de subir: quantos arquivos e quantos bytes de UPLOAD.
    O sync e incremental, entao re-rodar um exame ja no ar da zero."""
    out = capture(["aws", "s3", "sync", str(local_dir), s3_uri, "--delete", "--dryrun"])
    uploads, deletes, nbytes = 0, 0, 0
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("(dryrun) upload:"):
            uploads += 1
            local = line.split("upload:", 1)[1].split(" to ", 1)[0].strip()
            try:
                nbytes += Path(local).stat().st_size
            except OSError:
                pass  # so a estimativa fica curta; o sync em si nao depende disto
        elif line.startswith("(dryrun) delete:"):
            deletes += 1
    return uploads, deletes, nbytes


def warn_orphans(bucket, local_names):
    """Exame que existe no S3 e nao existe mais aqui. NAO apaga sozinho: sao
    centenas de MB de dado de paciente convertido, e o sync e por-exame (o
    --delete dele so enxerga dentro do proprio prefixo)."""
    try:
        out = capture(["aws", "s3", "ls", f"s3://{bucket}/{VOLUMES_PREFIX}/"])
    except subprocess.CalledProcessError:
        return
    remote = {line.split("PRE", 1)[1].strip().rstrip("/")
              for line in out.splitlines() if "PRE" in line}
    orphans = sorted(remote - set(local_names))
    if orphans:
        print("\n⚠  No S3 e nao aqui (nao removi):")
        for name in orphans:
            print(f"     {name}   -> aws s3 rm s3://{bucket}/{VOLUMES_PREFIX}/{name}/ --recursive")


def sync_volume(local_dir, uri):
    """Sobe um exame em DOIS passes, por causa do Content-Type.

    Sem --content-type o CLI adivinha pela extensao, e ".raw" nao esta na
    tabela dele: sai "image/RAW" (foi o que aconteceu com o
    abdomen-feet-first). Nao quebra o loader - o fetch le arrayBuffer - mas e
    header mentiroso, e o sync nunca reenviaria o arquivo pra corrigir depois,
    ja que ele decide por tamanho + mtime.

    O --delete fica nos dois passes: os filtros valem pros dois lados do sync,
    entao cada pass so enxerga (e so apaga) o que casa com o proprio filtro.
    """
    run(["aws", "s3", "sync", str(local_dir), uri, "--delete",
         "--cache-control", IMMUTABLE_CACHE,
         "--content-type", "application/octet-stream",
         "--exclude", "*.json"])
    run(["aws", "s3", "sync", str(local_dir), uri, "--delete",
         "--cache-control", IMMUTABLE_CACHE,
         "--content-type", "application/json",
         "--exclude", "*", "--include", "*.json"])


def fix_volume_headers(bucket, names):
    """
    Reescreve Cache-Control/Content-Type dos exames JA no bucket.

    Existe porque `aws s3 sync` decide o que subir por tamanho + mtime: exame
    que ja esta la em cima nao e reenviado, entao os headers que ele foi subido
    SEM (era o caso do abdomen-feet-first: Cache-Control ausente, Content-Type
    "image/RAW" adivinhado da extensao) ficariam assim pra sempre. O sync
    sozinho nunca conserta isso.

    Usa copy server-side com --metadata-directive REPLACE: o S3 reescreve o
    objeto no lugar, sem subir byte nenhum daqui. 371 objetos levam segundos.

    Heuristica de idempotencia: confere o Cache-Control de UM objeto do exame
    (todos sobem pelo mesmo caminho, entao ou todos tem ou nenhum tem) e pula
    o exame se ja estiver certo. Evita 371 head-object so pra decidir.
    """
    for name in names:
        prefix = f"{VOLUMES_PREFIX}/{name}"
        # --max-keys (parametro da API) e nao --max-items (paginacao do CLI):
        # o segundo faz o CLI anexar o NextToken numa 2a linha, e o "None" dele
        # ia junto na chave.
        probe = capture(["aws", "s3api", "list-objects-v2", "--bucket", bucket,
                         "--prefix", f"{prefix}/", "--max-keys", "1",
                         "--query", "Contents[0].Key",
                         "--output", "text"]).strip().splitlines()[0].strip()
        if not probe or probe == "None":
            print(f"  {name}: nao esta no bucket ainda (nada a corrigir)")
            continue
        head = json.loads(capture(["aws", "s3api", "head-object", "--bucket", bucket,
                                   "--key", probe,
                                   "--query", "{cc:CacheControl,ct:ContentType}",
                                   "--output", "json"]))
        # O probe pode calhar de ser o metadata.json; o esperado depende dele.
        want_ct = "application/json" if probe.endswith(".json") else "application/octet-stream"
        if head.get("cc") == IMMUTABLE_CACHE and head.get("ct") == want_ct:
            print(f"  {name}: headers ja corretos")
            continue
        print(f"  {name}: Cache-Control='{head.get('cc')}' Content-Type='{head.get('ct')}'"
              f" -> reescrevendo (copy server-side)")
        uri = f"s3://{bucket}/{prefix}/"
        # Dois passes: os .json tem content-type proprio, o resto e binario.
        # Sem --content-type explicito o CLI readivinha pela extensao e o .raw
        # volta a virar "image/RAW".
        run(["aws", "s3", "cp", uri, uri, "--recursive",
             "--metadata-directive", "REPLACE",
             "--cache-control", IMMUTABLE_CACHE,
             "--content-type", "application/octet-stream",
             "--exclude", "*.json"])
        run(["aws", "s3", "cp", uri, uri, "--recursive",
             "--metadata-directive", "REPLACE",
             "--cache-control", IMMUTABLE_CACHE,
             "--content-type", "application/json",
             "--exclude", "*", "--include", "*.json"])


def deploy_volumes(only=(), assume_yes=False, fix_headers=False):
    print("\n=== VOLUMES ===")
    if not FRONTEND_INFO.exists():
        sys.exit("deploy/frontend.json nao existe - rode provision_frontend.py primeiro.")
    info = json.loads(FRONTEND_INFO.read_text())
    bucket = info["bucket"]

    # Regenera o catalogo ANTES de subir. Sem isto, exportar um exame novo e
    # dar deploy sobe as fatias dele e nao a linha que o poe na lista - o exame
    # fica no ar, invisivel.
    run([sys.executable, str(INDEX_SCRIPT)], cwd=REPO)

    dirs = volume_dirs(list(only))
    if not dirs:
        sys.exit("Nenhum exame em public/volumes.")

    print("\nPlanejando (dry-run; o sync e incremental):")
    plans, total_files, total_bytes = [], 0, 0
    for d in dirs:
        uri = f"s3://{bucket}/{VOLUMES_PREFIX}/{d.name}"
        uploads, deletes, nbytes = sync_preview(d, uri)
        plans.append((d, uri, uploads, deletes, nbytes))
        total_files += uploads
        total_bytes += nbytes
        estado = "em dia" if uploads == 0 and deletes == 0 else \
                 f"{uploads} arquivo(s), {human(nbytes)}" + (f", {deletes} a remover" if deletes else "")
        print(f"  {d.name:24} {estado}")
    print(f"  {'TOTAL':24} {total_files} arquivo(s), {human(total_bytes)}")

    if total_files and total_bytes > CONFIRM_ABOVE_BYTES and not assume_yes:
        if input(f"\nSubir {human(total_bytes)} pro S3? [s/N] ").strip().lower() not in ("s", "sim", "y"):
            sys.exit("Cancelado.")

    changed = []
    for d, uri, uploads, deletes, _ in plans:
        if uploads == 0 and deletes == 0:
            continue
        sync_volume(d, uri)
        changed.append(d.name)

    # O index.json vai sempre e a parte: cache curto (e o unico arquivo daqui
    # que muda sozinho) e ele e o que faz um exame novo aparecer na lista.
    index_file = VOLUMES / "index.json"
    if not index_file.exists():
        sys.exit("public/volumes/index.json nao existe - o make_volumes_index.py falhou?")
    run(["aws", "s3", "cp", str(index_file), f"s3://{bucket}/{VOLUMES_PREFIX}/index.json",
         "--cache-control", INDEX_CACHE, "--content-type", "application/json"])

    # Headers dos exames que JA estavam no bucket (o sync nao os toca - ver
    # fix_volume_headers). Roda depois do sync pra pegar tambem o que acabou de
    # subir e conferir que saiu certo.
    if fix_headers:
        print("\nCorrigindo headers dos exames ja no bucket:")
        fix_volume_headers(bucket, [d.name for d in dirs])
        changed = [d.name for d in dirs]  # invalida todos: os headers mudaram

    paths = [f"/{VOLUMES_PREFIX}/index.json"] + [f"/{VOLUMES_PREFIX}/{n}/*" for n in changed]
    invalidate(paths)

    warn_orphans(bucket, [d.name for d in dirs])
    print(f"\nVolumes ok. {len(changed)} exame(s) atualizado(s), "
          f"{len(dirs)} no catalogo.")


def main():
    flags = {"--yes", "--fix-headers"}
    args = [a for a in sys.argv[1:] if a not in flags]
    assume_yes = "--yes" in sys.argv[1:]
    fix_headers = "--fix-headers" in sys.argv[1:]
    target = args[0] if args else None
    rest = args[1:]

    if target == "backend":
        deploy_backend()
    elif target == "frontend":
        deploy_frontend()
    elif target == "volumes":
        deploy_volumes(rest, assume_yes, fix_headers)
    elif target == "all":
        deploy_backend()
        deploy_frontend()
        deploy_volumes((), assume_yes, fix_headers)
    else:
        sys.exit("uso: python deploy/deploy.py [backend|frontend|volumes [exame...]|all] "
                 "[--yes] [--fix-headers]")


if __name__ == "__main__":
    main()
