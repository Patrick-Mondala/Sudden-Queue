# Deploying

One server, one database, one process. That is not a starting point to grow out
of — sockets and chat buffers live in process memory, so this scales by getting
a bigger box rather than more of them, and a second instance would mean players
who cannot see each other. See the ceiling note in the root README.

Written for Ubuntu LTS. Substitute your package manager elsewhere.

## Before you start

You need a **hostname**, not just an IP. Let's Encrypt will not issue a
certificate for a bare address, and without one the sign-in token crosses the
network in the clear and the Discord callback is an unencrypted URL. Point an
`A` record at the server and wait for it to resolve before the Caddy step.

## 1. A user for the app

```bash
sudo adduser --system --group --home /srv/sudden-queue suddenqueue
```

Nothing here needs root, so nothing here runs as root.

## 2. Node and Postgres

```bash
# Node 22 from NodeSource; Ubuntu's own is older than this needs.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

# Caddy is not in Ubuntu's repositories, so add theirs.
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key'   | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt'   | sudo tee /etc/apt/sources.list.d/caddy-stable.list

sudo apt-get update
sudo apt-get install -y nodejs postgresql caddy git
```

Postgres from apt rather than Docker: it is one database on one box, it binds
to localhost by default, and `pg_dump` works without a container wrapper. The
`docker-compose.yml` in this repo is a development convenience so you get a
Postgres on your laptop without installing one — it is not the production path.

```bash
sudo -u postgres psql -c "CREATE USER suddenqueue WITH PASSWORD 'CHANGE-THIS';"
sudo -u postgres psql -c "CREATE DATABASE suddenqueue OWNER suddenqueue;"
```

Use a generated password:

```bash
openssl rand -base64 24
```

Confirm it is not listening to the world. `ss -lntp | grep 5432` should show
`127.0.0.1:5432` and nothing else.

## 3. The code

```bash
sudo -u suddenqueue git clone https://github.com/Patrick-Mondala/Sudden-Queue.git /srv/sudden-queue
cd /srv/sudden-queue
sudo -u suddenqueue npm ci
```

**Install with dev dependencies — do not use `--omit=dev`.** `@suddenqueue/core`
is published as TypeScript source rather than compiled output, so the server
runs through `tsx` and there is no `dist/` to run instead. `tsx` is declared as
a runtime dependency for that reason, but `drizzle-kit` is not, and you need it
for migrations.

## 4. Configuration

```bash
sudo -u suddenqueue cp .env.example .env
sudo -u suddenqueue nano .env
```

The values that must change from the example:

| Key | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://suddenqueue:<password>@localhost:5432/suddenqueue` |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DISCORD_REDIRECT_URI` | `https://your.host/auth/discord/callback` |
| `NODE_ENV` | `production` |

Add the same callback URL to your Discord application under **OAuth2 →
Redirects**. It has to match exactly, character for character — a trailing
slash is a different URL and the failure looks like a Discord problem.

The `.env` holds a database password and a session secret. `chmod 600 .env`.

## 5. Migrations

```bash
sudo -u suddenqueue npm run -w @suddenqueue/server db:migrate
```

Deliberately a step you take rather than something the server does at boot: a
process that migrates on start will migrate production because somebody
restarted it.

## 6. Run it

```bash
sudo cp deploy/sudden-queue.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sudden-queue
systemctl status sudden-queue
```

```bash
curl -s localhost:3000/health     # {"ok":true}
curl -s localhost:3000/config     # the game this deployment serves
```

## 7. TLS

Put your hostname in the Caddyfile, then:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -s https://your.host/health
```

Caddy obtains and renews the certificate itself.

## 8. Backups

```bash
sudo cp deploy/backup.sh /usr/local/bin/sudden-queue-backup
sudo chmod +x /usr/local/bin/sudden-queue-backup
sudo -u postgres /usr/local/bin/sudden-queue-backup   # prove it works now
sudo crontab -e
#   17 4 * * *  /usr/local/bin/sudden-queue-backup >> /var/log/sudden-queue-backup.log 2>&1
```

Then edit it to copy the dump somewhere else. A backup that only exists on the
server it came from does not survive the thing most likely to destroy that
server.

**Restore, before you need to:**

```bash
gunzip -c /var/backups/sudden-queue/suddenqueue-<stamp>.sql.gz \
  | sudo -u postgres psql --dbname=suddenqueue
```

An untested backup is a hypothesis. Run that against a scratch database once
so you know the shape of it on a day when nothing is wrong.

## 9. The firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Port 3000 stays closed — Caddy reaches it over loopback.

## 10. Point the client at it

Set the repository variable `VITE_API_URL` to `https://your.host`, then tag a
release. That value is compiled into the installer, so it has to be right
*before* the build, not after.

## Updating

```bash
cd /srv/sudden-queue
sudo -u suddenqueue git pull
sudo -u suddenqueue npm ci
sudo -u suddenqueue npm run -w @suddenqueue/server db:migrate
sudo systemctl restart sudden-queue
```

Restarting drops every WebSocket. Clients reconnect on their own, but anyone
mid-accept loses that prompt, so prefer a quiet hour.

## When something is wrong

```bash
journalctl -u sudden-queue -f          # the server
journalctl -u caddy -f                 # TLS and proxying
sudo -u postgres psql -d suddenqueue   # the data
```

The config is validated at startup, so a missing or malformed value stops the
process with a message naming it rather than failing later as a confusing 500.
If the unit will not start, that message is the first place to look.
