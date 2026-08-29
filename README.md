# Sudden Queue

A matchmaking and team companion app for *Sudden Attack Zero Point*. Players
sign in with Discord, queue solo or as a party, get matched into 5v5 PUGs,
report the result, and climb a ladder. Teams can be formed, scrims arranged, and
disputes settled by a Game Master.

Unofficial and fan-made. Nothing here talks to the game itself — there is no API
to talk to — so results are self-reported by both captains and rating only moves
when they agree.

- **`apps/server`** — Fastify + Postgres. Every rule lives here.
- **`apps/desktop`** — Tauri v2 shell around a React client.
- **`packages/core`** — the constants and pure functions both sides share, so a
  rank threshold cannot mean two different things.

## Running it

You need **Node 22+**, **Docker** (for Postgres), and — for the desktop shell —
the **Rust toolchain** and **WebView2** (already present on Windows 11).

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

## Releasing the desktop app

Two things must be true before a release means anything.

**The signing key.** It lives at `~/.tauri/sudden-queue.key`, outside the repo
and gitignored. **Back it up.** If it is lost, every installed copy will reject
every future update, permanently — there is no reissue. If it leaks, whoever has
it can sign an update that every install accepts and runs.

**The endpoint.** `apps/desktop/src-tauri/tauri.conf.json` still points at
`CHANGE-ME`. Until it names the repository you actually publish to, installed
copies check a 404 and silently stay where they are.

Then, for each release — bump `version` in `tauri.conf.json` first:

```bash
cd apps/desktop
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sudden-queue.key)" npm run tauri build
npm run release:manifest -- --notes "What changed"
```

Upload the three files it names — the installer, its `.sig`, and `latest.json` —
to a GitHub release tagged `v<version>`. `tauri build` signs the installers but
does not write the manifest that points at them; in CI `tauri-action` fills that
gap, and by hand `release:manifest` does.

Builds are **not** code-signed with an Authenticode certificate, so Windows shows
a SmartScreen warning ("More info → Run anyway"), and machines with Smart App
Control enabled will block it outright. That is a deliberate trade for a fan
project — a certificate costs money and buys only the absence of that dialog.

## Deploying the server

Not done yet. What it needs: a host, a Postgres instance that is not the Docker
container on your desk, `DISCORD_REDIRECT_URI` and the Discord app's redirect
pointing at the real domain, and `VITE_API_URL` set when building the client so
it stops looking for `127.0.0.1:3000`.

It is a light workload — one websocket per player, a heartbeat that touches no
database, and pushed events only when something changes. A small VPS covers it.
The one ceiling worth knowing: sockets and chat buffers live in process memory,
so it scales by getting a bigger box, not more of them. Crossing that would mean
Redis for fan-out, somewhere north of a couple of thousand concurrent players.
