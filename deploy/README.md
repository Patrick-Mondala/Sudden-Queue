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
cd /srv/sudden-queue
sudo deploy/publish-release.sh            # the latest published release
sudo deploy/publish-release.sh v0.1.3     # or a particular one
```

It fetches the installer, `SHA256SUMS` and `latest.json` from the GitHub
release, verifies the checksum, and puts them where Caddy serves them from. It
prints the version now being served, asked the way a client asks for it.

Doing it by hand is three downloads whose order matters silently, which is why
there is a script. `latest.json` is what the server reads to decide which
clients it will still serve, so the moment it lands every older copy is refused
— and if the installer it names is not there yet, every player is locked out of
an app that cannot download the version it is being told to install. The script
stages everything in a temporary directory, checks it there, and moves the
manifest in last.

It refuses rather than half-finishes: a checksum that does not match, or a tag
whose manifest names a different version, leaves the live directory untouched.
Running it twice is free — it costs one small file to notice there is nothing to
do, so it is safe on a timer. Running it after a failed attempt finishes the
job.

The server checks `SHA256SUMS` for itself as well, before believing any
manifest, so even a botched manual copy fails safe: the floor stays where it was
and the log says why.

```bash
sudo docker compose -f compose.prod.yaml logs --tail 20 server | grep -i floor
```

Nothing restarts. The server picks up a new manifest within a few seconds --
including an installer that arrives late, which is why a bad publish recovers on
its own once the missing file is in place.

### Without watching it

The script is safe to run unattended, so a timer publishes releases on its own:

```bash
sudo crontab -e
#   */10 * * * *  cd /srv/sudden-queue && deploy/publish-release.sh >> /var/log/sudden-queue-publish.log 2>&1
```

Think before doing that. It only ever picks up releases that have been published
on GitHub rather than left as drafts, so nothing goes out that nobody looked at
— but publishing is a cutover, and a timer means the cutover happens whenever
the timer next fires rather than when you are watching. On a deployment with
players in it, that is a decision worth making on purpose.

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
