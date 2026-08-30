# Sudden Queue

A self-hostable matchmaking and team companion app for competitive games that
have no matchmaking of their own. Players sign in with Discord, queue solo or as
a party, get matched into rated 5v5 games, report the result, and climb a
ladder. Teams can be formed, scrims arranged, and disputes settled by a Game
Master.

Nothing here talks to a game client or its servers, which is the point: it needs
no cooperation from the publisher and no API to integrate with. Results are
self-reported by both captains, and rating only moves when they agree.

Ships configured for *Sudden Attack Zero Point*, unofficially and by fans.
Pointing it at a different game is environment variables, not a fork — see
[Using it for another game](#using-it-for-another-game).

Running it yourself? Two sections are for you:
[Deploying the server](#deploying-the-server) is the walkthrough from a bare box,
and [Making it yours](#making-it-yours) covers the values in the checkout that
belong to whoever published it — one of which decides who can ship updates to
your players.

- **`apps/server`** — Fastify + Postgres. Every rule lives here.
- **`apps/desktop`** — Tauri v2 shell around a React client.
- **`packages/core`** — the constants and pure functions both sides share, so a
  rank threshold cannot mean two different things.
- **`compose.prod.yaml`** and **`deploy/`** — the deployment: database, server
  and TLS in one file, with the Caddyfile, backup script and systemd unit beside
  it.

## Running it

The desktop app is **Windows only**, deliberately. The server runs anywhere
Node does.

To work on it you need **Node 22+**, **Docker** (for Postgres), and — for the
desktop shell — the **Rust toolchain** and **WebView2** (already present on
Windows 11).

```bash
npm install
cp .env.example .env      # then fill it in, see below
npm run db:up             # Postgres in Docker
npm run -w @suddenqueue/server db:migrate
npm run server            # http://127.0.0.1:3000
npm run desktop           # in a second terminal
```

Migrations do **not** run when the server starts. That is deliberate — a process
that migrates on boot will happily migrate production because someone restarted
it — so `db:migrate` is always a thing you chose to do.

### Filling in `.env`

`.env.example` documents each value. Two need real work:

**`SESSION_SECRET`** — any 32+ character string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Discord OAuth** — create an application at
[discord.com/developers/applications](https://discord.com/developers/applications),
then under **OAuth2 → Redirects** add exactly:

```
http://127.0.0.1:3000/auth/discord/callback
```

Copy the client ID and secret into `.env`. The app only ever requests the
`identify` scope. Sign-in opens your real browser rather than a webview, because
Discord blocks embedded webviews and because you should be able to see the
address bar before typing a password.

The config is validated at startup, so a missing secret stops the process with a
clear message instead of surfacing as a confusing 500 later.

### Without the desktop shell

The client runs in a plain browser too, which is faster to iterate on and avoids
Windows' Smart App Control blocking an unsigned local build:

```bash
npm run -w @suddenqueue/desktop dev     # http://localhost:1420
```

Everything works except the parts that need the shell: single-instance and the
updater. Both are feature-detected, so their absence is silent rather than fatal.

## Deploying the server

Database, server and TLS come up together, as one stack. From a bare Ubuntu box
to players signing in is the seven steps below.

It is a light workload: one websocket per player, a heartbeat that touches no
database, and pushed events only when something changes. A small VPS covers it.
The one ceiling worth knowing is that sockets and chat buffers live in process
memory, so it scales by getting a bigger box, not more of them. Crossing that
would mean Redis for fan-out, somewhere north of a couple of thousand
concurrent players.

You need a host, a domain with an A record pointed at it, and a Discord
application. The A record matters before you start rather than after: Caddy asks
Let's Encrypt for the certificate the moment it boots, and Let's Encrypt will not
issue one for an address that does not resolve to you. To prove the stack works
before DNS exists, set `SQ_HOSTNAME=:80` and Caddy serves plain HTTP — fine for a
`curl`, wrong for players, since sign-in tokens would cross the network in the
clear.

### 1. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
```

### 2. The code and its configuration

```bash
sudo git clone https://github.com/Patrick-Mondala/Sudden-Queue.git /srv/sudden-queue
cd /srv/sudden-queue
sudo cp .env.example .env
sudo nano .env
sudo chmod 600 .env
```

Five values must be set. Everything else in the file has a working default:

| Key | What it is |
| --- | --- |
| `SQ_HOSTNAME` | your domain — the certificate is issued for this name |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` |
| `SESSION_SECRET` | `openssl rand -hex 32`, 32 characters minimum |
| `DISCORD_CLIENT_ID` / `_SECRET` | from your Discord application |
| `DISCORD_REDIRECT_URI` | `https://your.host/auth/discord/callback` |

**Hex, not base64,** for both generated secrets. The database password ends up
inside a connection URL, and a `/` from base64 does not truncate that URL — it
makes the whole string unparseable, so the connection fails before it is
attempted.

Leave `DATABASE_URL` alone. Compose assembles it from `POSTGRES_USER`,
`POSTGRES_PASSWORD` and `POSTGRES_DB`, so the password has no second place to
disagree with itself.

### 3. Bring it up

```bash
sudo mkdir -p releases
sudo docker compose -f compose.prod.yaml up -d --build
sudo docker compose -f compose.prod.yaml --profile migrate run --rm migrate
```

`releases/` is where the published installer and its `latest.json` go. It is
mounted read-only into both Caddy, which serves it at `/download`, and the
server, which reads the version out of it. Empty is fine and is what it looks
like until your first release — a deployment that has published nothing enforces
no version floor.

Two commands rather than one because migrations are a deliberate step, here for
the same reason they are in development: a process that migrates when it boots
migrates production because somebody restarted it.

The first build takes a few minutes. Caddy obtains and renews the certificate
itself, and is the only container that publishes a port — Postgres has no
`ports:` at all and is reached over the internal network, because publishing
5432 on a public host is how a database gets found.

### 4. Check it

```bash
sudo docker compose -f compose.prod.yaml ps          # three services up
curl -s https://your.host/health                     # {"ok":true}
curl -s https://your.host/config                     # the game this serves
```

If `/health` answers and `/config` describes your game, the stack is right and
anything still wrong is Discord or DNS. Logs are
`sudo docker compose -f compose.prod.yaml logs -f server`.

### 5. Tell Discord where to come back to

Under **OAuth2 → Redirects** in your Discord application, add the value you put
in `DISCORD_REDIRECT_URI`:

```
https://your.host/auth/discord/callback
```

It must match character for character — a trailing slash is a different URL, and
the failure reads like a Discord problem rather than a configuration one.

### 6. A firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw --force enable
```

### 7. Make yourself a Game Master

Sign in through the app once so the account exists, then:

```bash
sudo docker compose -f compose.prod.yaml exec server \
  npm run grant -- --discord <your discord id> --role game_master
```

That is the server running. The client still has to be pointed at it: set the
repository variable `VITE_API_URL` to `https://your.host` **before** tagging a
release, because that URL is compiled into the installer — see
[Releasing the desktop app](#releasing-the-desktop-app).

[deploy/README.md](deploy/README.md) covers what comes after the first day:
backups and restoring one before you need it, updates and logs, and the systemd
unit beside the Caddyfile for running the server straight from a checkout if you
would rather manage Node and Postgres yourself.

## Working on it

```bash
npm run check     # lint + typecheck + every test. Run before committing.
npm test          # tests alone
npm run lint
```

The server tests need Postgres up: they create a separate `suddenqueue_test`
database, migrate it, and truncate between tests. They never touch your dev data.

The client tests mount the real component tree under jsdom. That is not
belt-and-braces — three crashes reached the user as a blank window because a
build stayed green, so the linter now catches undefined and use-before-define,
and these tests catch what it cannot.

### Two rules worth knowing before changing anything

**Rating numbers never leave the server.** Rank letters are the only published
measure of strength. Several tests walk entire payloads asserting no rating
appears; if you add a route that returns player data, it needs the same.

**Tier is derived, never stored.** `tierForRating` in `packages/core` is the only
place thresholds live, so recalibrating them against real population data is a
constants change rather than a migration.

## Filling the queue on your own

A match needs ten players, so one account can never pop one. The seeder plays
the other nine — over real HTTP against the running server, so the websocket
events your client is waiting on actually fire.

```bash
npm run seed                              # 9 bots + you = one match
npm run seed -- --region eu --rating 1500
npm run seed -- --count 10 --play false   # a match with no human in it
npm run seed -- --cleanup                 # removes them, reverses their ratings
```

Every account it creates is prefixed `seed:`, and `--cleanup` reverses rating
changes through the ledger rather than deleting rows out from under completed
matches.

## Game Masters

Game Masters settle disputes and suspend accounts. There is no route that
promotes anyone — the only way is someone with database access saying so, which
is the right shape for a privilege that can overturn results:

```bash
npm run grant -- --discord <discord id> --role game_master
npm run grant -- --discord <discord id> --role player
npm run grant -- --list
```

The role is read from the database on every request, so it takes effect
immediately; the client picks up the badge on its next `/me`.

## Making it yours

If you are running this rather than contributing to it, five things in the
checkout belong to somebody else's deployment. Four are inconvenient. The first
is not.

### 1. Generate your own updater keypair

```bash
cd apps/desktop
npx tauri signer generate -w ~/.tauri/<your-app>.key
```

Put the **public** half in `apps/desktop/src-tauri/tauri.conf.json` under
`plugins.updater.pubkey`, replacing the one that ships.

**Do not skip this.** That field currently holds the key of whoever published
this repository. An app built with someone else's public key installs updates
*they* sign and refuses every update *you* sign — so you could not ship a fix to
your own users, and they could ship anything to them. Replacing it is the
difference between running your own deployment and hosting theirs.

Keep the private half out of the repository and **back it up**. If it is lost,
every installed copy rejects every future update, permanently — there is no
reissue. If it leaks, whoever has it can sign an update that every install
accepts and runs.

### 2. Point the updater at your releases

In the same file, `plugins.updater.endpoints` names the deployment this checkout
was published from — `https://suddenqueue.com/download/latest.json`. Point it at
yours.

Updates are served by your own server rather than from a release host: the app
refuses to open until it has been told whether it is current, so whatever
answers that question is something every player needs reachable before they can
play. Served from the same deployment as the matches, it is up exactly when the
rest of it is, and no third party's outage can stop play on a server that is
fine.

Leaving the endpoint as it ships is worse than emptying it. Installed copies
would ask someone else's deployment whether they are current, and
`release:manifest` resolves the installer url against the same value, so your
`latest.json` would send your players to a download you do not control. The only
version of this mistake the script catches by itself is the literal `CHANGE-ME`
placeholder, which it refuses to run on.

In CI you do not set this twice: the release workflow writes the endpoint from
`VITE_API_URL`, so the host a client talks to and the host it updates from
cannot drift apart.

### 3. Change the bundle identifier

`identifier` in `tauri.conf.json` is `com.gentl.suddenqueue`. Two builds
sharing one identifier collide: they fight over the same install location and
the same single-instance lock, so a player with both installed can only run one
at a time.

### 4. Set a real database password

`docker-compose.yml` and the `DATABASE_URL` in `.env.example` carry
`suddenqueue_dev`, which is fine on your own machine and nowhere else. A real
deployment sets `POSTGRES_PASSWORD` and lets compose assemble the URL from it —
[step 2 of the walkthrough](#2-the-code-and-its-configuration).

### 5. Your own Discord application and session secret

Both covered under [Filling in `.env`](#filling-in-env). The session secret
signs cookies for your deployment; generate a new one rather than reusing any
value you found written down.

## Releasing the desktop app

Assumes you have done [Making it yours](#making-it-yours) — your own signing
key, and an endpoint that names your repository. Without both, a release either
cannot be built or cannot be installed.

### By tag, in CI

Once the repository exists and the two settings below are in place, a release
is a tag:

```bash
# bump "version" in apps/desktop/src-tauri/tauri.conf.json first
git tag v0.1.2 && git push --tags
```

The workflow refuses a tag that disagrees with that version, because the updater
compares against the declared one — ship a mismatch and the update installs and
then offers itself again, forever. It builds, signs, writes `latest.json` and
opens a **draft** release, so nothing goes out until a person looks at it.

Two settings on the repository:

| Where | Name | Value |
| --- | --- | --- |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | the contents of your private key file |
| Variable | `VITE_API_URL` | the server the shipped client should talk to |

Without the secret the installers still build, carry no signature, and every
client refuses them. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too if you ever
put a passphrase on the key. `VITE_API_URL` does double duty: the workflow
refuses to build without it, and derives the updater endpoint from it, so the
client cannot end up talking to one host and updating from another.

### Publishing it

CI builds and signs; the GitHub release is where the artifacts are kept. What
players actually download comes from your server, so the last step of a release
is copying two files into the `releases/` directory beside `compose.prod.yaml`:

```bash
# on the server, from the GitHub release
cd /srv/sudden-queue/releases
sudo curl -LO https://github.com/<you>/<repo>/releases/download/v0.1.2/Sudden.Queue_0.1.2_x64-setup.exe
sudo curl -LO https://github.com/<you>/<repo>/releases/download/v0.1.2/latest.json
```

**The installer first, `latest.json` second.** The order is not cosmetic. The
server reads `latest.json` to decide which client versions it will still serve,
so the moment that file lands, every older copy is refused — and if the
installer it names is not there yet, everyone is locked out of an app that
cannot download the version it is being told to install.

Nothing needs restarting. The server notices the new manifest within a few
seconds.

### Updates are not optional

There is no "Later". The client checks once at launch, ahead of the sign-in
screen, and will not open until it is current. A check it cannot make counts as
not current too: it blocks and keeps retrying rather than opening on a version
nothing has vouched for, because "required unless you can arrange for the check
to fail" is a bar an offline machine clears.

That is the client keeping a promise about itself, which is not enforcement — a
binary that never restarts never sees the gate. So the server keeps the same
rule independently: every request carries `X-Client-Version`, and anything below
the version in `latest.json` is refused with `426`. Not sending a version at all
is refused as well, which is what every copy built before this existed does.

The floor is the published version rather than a setting of its own, so there is
nothing to remember to raise and nothing to disagree with. The consequence is
the one in the step above: publishing is a cutover, and it locks out everyone
who has not restarted yet. Publish when you are around to notice if it was
wrong.

Two exemptions on the server, both deliberate. `/health` and `/config` answer
any version, so a monitor keeps working and a refused client can still render
enough to say why. The Discord sign-in routes answer too, because the user's
browser follows those and a browser has no version to send.

One on the client: a development build does not check at all. It has no
published version to be behind, and a deployment that has not released yet
answers the endpoint with a 404 — which the updater raises as an error, not as
"nothing to install", so `npm run desktop` would otherwise sit against the gate
forever.

The order this imposes is worth saying once more, because getting it wrong locks
everyone out rather than merely inconveniencing them: publish before anyone
installs. A copy of a version whose `latest.json` is not on the server yet
cannot open, and cannot fetch the thing that would fix it.

### By hand

Bump `version` in `tauri.conf.json` first:

```bash
cd apps/desktop
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/<your-app>.key)" npm run tauri build
npm run release:manifest -- --notes "What changed"
```

Upload the three files it names — the installer, its `.sig`, and `latest.json` —
to a GitHub release tagged `v<version>`. `tauri build` signs the installers but
does not write the manifest that points at them, so `release:manifest` fills that
gap. CI runs the same script rather than a second implementation of it, which is
why a release built by hand and one built by tag describe themselves the same
way.

Builds are **not** code-signed with an Authenticode certificate, so Windows shows
a SmartScreen warning ("More info → Run anyway"), and machines with Smart App
Control enabled will block it outright. That is a deliberate trade for a fan
project — a certificate costs money and buys only the absence of that dialog.

## Using it for another game

Everything that describes a *game* rather than the tool is read from the
environment at startup. `.env.example` lists each one; the defaults are a 5v5
shooter, so an unconfigured checkout still runs.

```bash
SQ_APP_NAME="Rocket Queue"
SQ_GAME_NAME="Rocket League"
SQ_TEAM_SIZE=3
SQ_REGIONS=oce:Oceania,eu:Europe
SQ_TIERS=Bronze,Silver,Gold,Platinum
SQ_TIER_FLOORS=0,900,1200,1500
```

That is a whole deployment: 3v3, two regions, four ranks with different names.
Match size is always twice the team size and is never set separately.

Values are validated at startup and a bad one stops the process rather than
producing a match of the wrong size later. Ranks and their floors are
index-aligned, so the counts must match and the floors must increase — a rating
that mapped to two ranks would stop the ladder being an order.

**The client compiles none of it in.** A shipped desktop binary cannot read your
server's environment, so it asks `GET /config` on startup and renders whatever
it is told — your name, your regions, your rank names, your team size. The same
installer works against any deployment. If the server cannot be reached it falls
back to the built-in defaults, because a first paint on stale values beats a
blank window.

What is *not* configurable is deliberate: accept windows, cooldowns, rate limits
and the matchmaking ramp are tuning rather than game shape, and most deployments
should leave them alone. They live in `packages/core/src/constants.ts`.

## Languages

English only so far, but every string in the interface goes through a lookup, so
adding a language is a file rather than a hunt through the source for text that
was never marked as text.

The English sentence is its own key. `t("Ready to queue")` returns that string
unchanged when nothing is translated, which means an untranslated build is a
working English one, a half-finished catalogue is a half-translated app rather
than a broken one, and nobody has to invent key names or keep them in step with
the copy.

Refusals from the server are handled by code — `error.CAPTAIN_OFFLINE` — falling
back to the English sentence the server sent. So a refusal added on the server
today reads properly today, rather than going blank in every language until
someone remembers to translate it.

See [`apps/desktop/src/i18n/README.md`](apps/desktop/src/i18n/README.md) to add
one.

## Licence

MIT — see [LICENSE](LICENSE). Use it, change it, host it, fork it commercially
if you like; keep the copyright notice with the source.

If you run this for your community, a link back is appreciated but not required.
The licence asks for attribution in the source, not on screen, and any footer in
the default build is yours to remove.
