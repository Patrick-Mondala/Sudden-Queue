# Deploying

Database, server and TLS as one stack. Two commands on a fresh Ubuntu box.

One server, one database, one process — that is not a starting point to grow
out of. Sockets and chat buffers live in process memory, so this scales by
getting a bigger box rather than more of them, and a second server container
would mean players who cannot see each other.

## 1. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
```

## 2. The code and its configuration

```bash
sudo git clone https://github.com/Patrick-Mondala/Sudden-Queue.git /srv/sudden-queue
cd /srv/sudden-queue
sudo cp .env.example .env
sudo nano .env
```

Five values must be set. Everything else has a working default.

| Key | How |
| --- | --- |
| `SQ_HOSTNAME` | your domain, or `:80` to test on a bare IP over plain HTTP |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DISCORD_CLIENT_ID` / `_SECRET` | from your Discord application |
| `DISCORD_REDIRECT_URI` | `https://your.host/auth/discord/callback` |

**Hex, not base64.** The database password ends up inside a connection URL, and
a `/` from base64 does not truncate that URL — it makes it unparseable, and the
connection fails before it is attempted.

`DATABASE_URL` is assembled by compose from the Postgres values, so there is no
second place for the password to disagree with itself. Leave it alone.

```bash
sudo chmod 600 .env
```

## 3. Up

```bash
sudo docker compose -f compose.prod.yaml up -d --build
sudo docker compose -f compose.prod.yaml --profile migrate run --rm migrate
```

Migrations are a separate, deliberate step. A process that migrates when it
boots will migrate production because somebody restarted it.

```bash
sudo docker compose -f compose.prod.yaml ps
curl -s https://your.host/health     # {"ok":true}
curl -s https://your.host/config     # the game this deployment serves
```

Caddy obtains and renews the certificate itself. Nothing is published except 80
and 443 — the database has no `ports:` at all, and the server is reached over
the internal network.

## 4. Discord

Add `https://your.host/auth/discord/callback` to your Discord application under
**OAuth2 → Redirects**. It must match `DISCORD_REDIRECT_URI` character for
character; a trailing slash is a different URL, and the failure looks like a
Discord problem rather than a configuration one.

## 5. A firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw --force enable
```

## 6. Backups

The stack keeps its data in a Docker volume, which survives `down` but not a
dead server.

```bash
sudo cp deploy/backup.sh /usr/local/bin/sudden-queue-backup
sudo chmod +x /usr/local/bin/sudden-queue-backup
sudo SQ_IN_DOCKER=1 /usr/local/bin/sudden-queue-backup
sudo crontab -e
#   17 4 * * *  SQ_IN_DOCKER=1 /usr/local/bin/sudden-queue-backup >> /var/log/sudden-queue-backup.log 2>&1
```

Then edit its last lines to copy the dump off this machine. A backup that lives
only on the server it came from does not survive the thing most likely to
destroy that server.

**Restore once before you need to.** An untested backup is a hypothesis:

```bash
gunzip -c /var/backups/sudden-queue/suddenqueue-<stamp>.sql.gz \
  | sudo docker compose -f /srv/sudden-queue/compose.prod.yaml exec -T postgres psql -U suddenqueue -d suddenqueue
```

## 7. Make yourself a Game Master

Sign in through the app once so the account exists, then:

```bash
sudo docker compose -f compose.prod.yaml exec server \
  npm run grant -- --discord <your discord id> --role game_master
```

## 8. Point the client at it

Set the repository variable `VITE_API_URL` to `https://your.host` and the
secret `TAURI_SIGNING_PRIVATE_KEY` to your signing key, then tag a release.
That URL is compiled into the installer, so it has to be right *before* the
build.

## Day to day

```bash
# update
cd /srv/sudden-queue && sudo git pull
sudo docker compose -f compose.prod.yaml up -d --build
sudo docker compose -f compose.prod.yaml --profile migrate run --rm migrate

# logs
sudo docker compose -f compose.prod.yaml logs -f server
sudo docker compose -f compose.prod.yaml logs -f caddy

# stop / start
sudo docker compose -f compose.prod.yaml down
sudo docker compose -f compose.prod.yaml up -d
```

`down` leaves the database volume alone. `down -v` deletes it, which is what
you want on a test box and never on a real one.

Restarting drops every WebSocket. Clients reconnect on their own, but anyone
mid-accept loses that prompt, so prefer a quiet hour.

## Without Docker

`sudden-queue.service` is a systemd unit for running the server directly from a
checkout, if you would rather manage Node and Postgres yourself. You will need
Node 22, a Postgres, and `npm ci` **with** dev dependencies — `@suddenqueue/core`
is published as TypeScript source, so the server runs through `tsx` and there is
no compiled output to run instead.

The container path is the supported one. This exists because it was written
first.
