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

Running it yourself? Start with [Making it yours](#making-it-yours) — a few
values in the checkout belong to whoever published it, and one of them decides
who can ship updates to your players.

- **`apps/server`** — Fastify + Postgres. Every rule lives here.
- **`apps/desktop`** — Tauri v2 shell around a React client.
- **`packages/core`** — the constants and pure functions both sides share, so a
  rank threshold cannot mean two different things.

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

In the same file, `plugins.updater.endpoints` ships as `CHANGE-ME`. Until it
names the repository you publish to, installed copies check a 404 and silently
stay on the version they have. The release script refuses to run while it says
`CHANGE-ME`, so this cannot ship wrong by accident.

### 3. Change the bundle identifier

`identifier` in `tauri.conf.json` is `com.gentl.suddenqueue`. Two builds
sharing one identifier collide: they fight over the same install location and
the same single-instance lock, so a player with both installed can only run one
at a time.

### 4. Set a real database password

`docker-compose.yml` and `.env.example` carry `suddenqueue_dev`, which is fine
on your own machine and nowhere else. A hosted deployment needs a real password
in `DATABASE_URL`, and a database that is not reachable from the internet.

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
git tag v0.1.1 && git push --tags
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
put a passphrase on the key.

### By hand

Bump `version` in `tauri.conf.json` first:

```bash
cd apps/desktop
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/<your-app>.key)" npm run tauri build
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

## Licence

MIT — see [LICENSE](LICENSE). Use it, change it, host it, fork it commercially
if you like; keep the copyright notice with the source.

If you run this for your community, a link back is appreciated but not required.
The licence asks for attribution in the source, not on screen, and any footer in
the default build is yours to remove.
