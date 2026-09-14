# The dashboard as one container — for Dokploy, or any Docker host.
#
# A carbon copy of what Vercel runs, built from the same source: the same
# Next.js standalone server, the same env vars (see web/.env.example), the
# same Supabase/Google/Metricool on the other end. Only two things differ, and
# both are simpler here than on Vercel:
#
#   - ffmpeg comes from the OS package, on disk, always. Vercel could not ship
#     the 77 MB binary inside its functions (it filled the account's Function
#     Storage), so there it is fetched at first use; here FFMPEG_PATH points at
#     /usr/bin/ffmpeg and lib/audio-extract.ts takes the first, simplest path.
#   - The daily crons are Dokploy Schedule Jobs (web/deploy/dokploy-schedules.json)
#     that run scripts/cron-tick.mjs inside this container, instead of
#     vercel.json. Same routes, same CRON_SECRET.
#
# Build context is the REPO ROOT (Dokploy's default), the app lives in web/.

# --- deps: install exactly the lockfile -------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
# --ignore-scripts: ffmpeg-static's install script would download a 77 MB
# binary that this image never uses (ffmpeg comes from apt below), and
# nothing else in the tree needs a lifecycle script to build.
RUN npm ci --ignore-scripts

# --- builder: compile the app ----------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./
ENV DOCKER_BUILD=1 \
    NEXT_TELEMETRY_DISABLED=1
# `npx next build` rather than `npm run build`: the prebuild step only checks
# that ffmpeg-static's binary is present, which is deliberately not the case
# here.
RUN npx next build

# --- runner: the smallest image that can serve --------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    FFMPEG_PATH=/usr/bin/ffmpeg
# The standalone server, its traced node_modules, the static assets and the
# public folder (brand marks, open-licence fonts). Owned by the unprivileged
# user the server runs as.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/scripts/cron-tick.mjs ./scripts/cron-tick.mjs
USER node
EXPOSE 3000
# /sign-in is served without a session; /api/health needs one, so it is not
# the liveness probe. Anything but a 5xx means the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/sign-in').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
