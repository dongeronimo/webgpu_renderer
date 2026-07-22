# Gauntlet (multiplayer)

Shooter/gauntlet multiplayer, server autoritativo. Duas metades neste repositório:

- **Client** — o mundo `gauntlet` da engine WebGPU (`src/gauntlet/`, UI em `src/ui/gauntlet/`). Servido pelo dev server do Vite.
- **Server** — app Spring Boot em `gauntlet_server/gauntlet/` (WebSocket autoritativo, REST de settings, banco H2 em arquivo, login por sessão).

O client **não fala direto** com o server: o dev server do Vite faz proxy de `/ws`, `/login`, `/logout` e `/api` pro Spring, deixando tudo same-origin (ver `vite.config.ts`). Então tudo passa pela porta do Vite.

```
  browser (WebGPU)
      │  http://localhost:5173
      ▼
  Vite dev server ──proxy──► Spring Boot
   (5173)                     (8080)
   /ws  /login /logout /api        │
                                   ▼
                            H2 file db (./data/gauntlet)
```

| Serviço | Porta | Observação |
|---|---|---|
| Client (Vite) | **5173** | é aqui que você abre o browser; troca por `$env:PORT` |
| Server (Spring Boot) | **8080** | default do Boot (não tem `server.port` no `application.properties`) |
| H2 console | 8080 | em `/h2-console`, **não** passa pelo proxy do Vite — acessa direto no 8080 |

---

## Pré-requisitos

- **Node** + `npm install` já rodado na raiz (o client é o mesmo do resto da engine).
- **JDK 21** (o `pom.xml` fixa `java.version=21`). O Maven vem via wrapper, não precisa instalar.
- **Browser com WebGPU** — Chrome ou Edge recentes. Firefox/Safari podem não ter WebGPU ligado.

---

## 1) Subir o server (primeiro)

O server é dono da porta 8080, semeia o banco e precisa estar de pé antes do proxy do client ter pra onde apontar.

```powershell
# PowerShell, a partir da raiz do repo
cd gauntlet_server\gauntlet
.\mvnw.cmd spring-boot:run
```

Na primeira subida com o banco vazio ele semeia **Alice** e **Bob** (ver logins abaixo) e cria/atualiza o schema (`ddl-auto=update`). Espere o log `Started GauntletApplication`.

O banco é um arquivo H2 em `gauntlet_server/gauntlet/data/gauntlet.mv.db` (relativo ao diretório de trabalho do processo). **Persiste entre restarts** — o seed só roda de novo se o banco estiver vazio.

## 2) Subir o client

Noutro terminal, na **raiz** do repo:

```powershell
npm run dev
# porta custom: $env:PORT=4000; npm run dev
```

Abre **http://localhost:5173**.

> A porta importa: acesse pela porta do Vite (5173), nunca pela 8080 direto. O client resolve os WebSockets como `ws://${location.host}/ws/...`, contando com o proxy do Vite pra chegar no Spring. Abrir a 8080 no browser não te dá o client — só o backend.

## 3) No browser

1. No painel **World Switch** (canto superior direito), clique em **"Gauntlet (multiplayer)"**. O boot world é outro (Skinning), então essa troca é obrigatória.
2. No painel **Gauntlet** (canto superior esquerdo), faça login com um dos usuários de dev.
3. Escolhido o login, abre o modal **"Escolha seu personagem"**. Jogáveis: **Dmitry, Nat, Abigail, Ramirez** (Yukio está desabilitado/em preparação).
4. A partir daí o client dispara sozinho o rito de conexão: `GET /api/player-controller-settings/{personagem}` → `/ws/signaling` (join) → `/ws/game` (welcome, mapSync, stateSync). Você spawna na dungeon.

---

## Logins de dev

Semeados em `PlayerPersistence` na primeira subida com banco vazio. Senhas em `{noop}` (texto puro, sem hash — é dev):

| Usuário | Senha |
|---|---|
| `Alice` | `foobar` |
| `Bob` | `lorenipsun` |

> A senha do Bob é `lorenipsun` mesmo (não "lorenipsum") — é o valor literal do seed.

---

## Testar dois players na mesma máquina

O login vira **cookie de sessão**, então dois players precisam de dois cookies separados — não basta duas abas do mesmo perfil. Faça:

1. Uma janela normal → login **Alice**.
2. Uma janela **anônima** (ou outro perfil do browser) → login **Bob**.

Ambas em `http://localhost:5173`, ambas no mundo Gauntlet. Um vê o pawn do outro (personagem que cada um escolheu viaja pela rede, server-authoritative). Um só server/instância serve os dois.

---

## H2 console (inspecionar o banco na mão)

Registrado manualmente em `H2ConsoleConfig` e liberado do login em `SecurityConfig`. **Não** está no proxy do Vite, então abre direto no server:

- URL: **http://localhost:8080/h2-console**
- No form de conexão, use exatamente:

| Campo | Valor |
|---|---|
| JDBC URL | `jdbc:h2:file:./data/gauntlet` |
| User Name | `sa` |
| Password | `sa` |

O console roda dentro do mesmo processo do server, então esse caminho relativo resolve pro mesmo arquivo que o app já abriu (não precisa parar o server pra olhar). A senha não pode ficar em branco — o form do H2 recusa; qualquer valor serve, `sa` é o configurado.

---

## Resetar o banco

Pare o server e apague o arquivo do H2:

```powershell
Remove-Item gauntlet_server\gauntlet\data\gauntlet.mv.db
```

Na próxima subida o schema é recriado e Alice/Bob são semeados de novo.

---

## Troubleshooting

- **"Login falhou" no painel** — server não está de pé, ou usuário/senha errados. Confere o terminal do `mvnw` e o `lorenipsun` do Bob.
- **Tela do client não carrega / erro de WebGPU** — browser sem WebGPU. Use Chrome/Edge recentes.
- **WS não conecta / 403 nos `/ws/**`** — os endpoints exigem sessão autenticada (`ROLE_PLAYER`). Faz o login antes; o handshake do WS herda o cookie. Se abriu a 8080 direto em vez da 5173, o same-origin do proxy não vale — volte pra 5173.
- **`/h2-console` redireciona pro login** — você está tentando pela 5173 (proxy não cobre essa rota). Use `http://localhost:8080/h2-console`.
- **Porta 8080 ocupada** — outro processo Java/Spring rodando. Mate-o, ou adicione `server.port=...` em `application.properties` (e ajuste os `target:` do proxy no `vite.config.ts` pra bater).
