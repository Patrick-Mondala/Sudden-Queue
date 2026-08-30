# The server, as one artifact.
#
# Built from the repository root so the workspace layout is intact:
#   docker build -f apps/server/Dockerfile .
#
# There is no compile step. @suddenqueue/core is published as TypeScript
# source, so the server runs through tsx and the image carries the sources it
# runs. That is why tsx is a runtime dependency rather than a dev one.
FROM node:22-alpine

# tini reaps zombies and forwards signals, so a `docker compose down` reaches
# the server as a real SIGTERM and it closes its sockets on the way out
# instead of being killed after the timeout.
RUN apk add --no-cache tini

WORKDIR /app

# Manifests first: this layer only rebuilds when a dependency changes, not
# when a line of application code does.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/

# Only the two workspaces the server needs. The desktop workspace pulls the
# Tauri toolchain and platform binaries, none of which belong in a server
# image -- but its manifest has to be present for npm to resolve the lockfile.
#
# Dev dependencies are kept: drizzle-kit lives there and migrations run from
# this image.
RUN npm ci \
      --workspace @suddenqueue/core \
      --workspace @suddenqueue/server \
      --include-workspace-root \
      --ignore-scripts

COPY packages/core packages/core
COPY apps/server apps/server

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Runs as the node user rather than root. Nothing here writes to disk.
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start", "--workspace", "@suddenqueue/server"]
