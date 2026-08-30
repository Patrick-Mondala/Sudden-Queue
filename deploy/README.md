# Deploying

Database, server and TLS as one stack, and what to do with it once it is up.

One server, one database, one process — that is not a starting point to grow
out of. Sockets and chat buffers live in process memory, so this scales by
getting a bigger box rather than more of them, and a second server container
would mean players who cannot see each other.

The first run — Docker, `.env`, bringing the stack up, the Discord redirect, the
firewall, your first Game Master — is [in the main
README](../README.md#deploying-the-server). It lives there so somebody deciding
whether to host this can read what it takes without opening a second file.

This is everything after that first run.

## Backups

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

## Publishing a client release

CI builds and signs it; this is what puts it in front of players. Both files go
in `releases/`, which Caddy serves at `/download` and the server reads the
current version out of.

```bash
cd /srv/sudden-queue/releases
sudo curl -LO https://github.com/<you>/<repo>/releases/download/v0.1.2/Sudden.Queue_0.1.2_x64-setup.exe
sudo curl -LO https://github.com/<you>/<repo>/releases/download/v0.1.2/latest.json
curl -s https://your.host/download/latest.json     # the version you just published
```

**Installer first, `latest.json` second**, and not the other way round.
`latest.json` is what the server reads to decide which clients it will still
serve, so the moment it lands every older copy is refused. If the installer it
names is not there yet, every player is locked out of an app that cannot
download the version it is being told to install.

Nothing restarts. The server picks up the new manifest within a few seconds.

Old installers can stay where they are. Nothing points at them once
`latest.json` moves on, and keeping them means a link somebody saved still
works.

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
