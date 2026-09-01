# Ratchet — one image, two entrypoints.
#
#   API / control plane:  node dist/api/server.js      (stateless, scale freely)
#   Worker:               node dist/worker/main.js     (long-running, 1+ replicas)
#
# The worker must NOT be deployed as a serverless function: it expires leases and
# delivers webhooks on a timer, whether or not a request is in flight.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
WORKDIR /app

# Which commit this image was built from.
#
# Deliberately NOT served on any public endpoint. The repository is open, so
# publishing the exact deployed commit tells anyone who asks precisely which
# fixes an instance is missing. The deploy script reads it through flyctl, which
# is authenticated, and that is the only consumer.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV NODE_ENV=production

RUN apk add --no-cache tini && addgroup -S app && adduser -S app -G app

COPY --from=deps  --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app src/db/migrations ./dist/db/migrations
COPY --chown=app:app web ./web
COPY --chown=app:app package.json ./

USER app
EXPOSE 8787

# tini reaps zombies and forwards SIGTERM, so the drain path actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/api/server.js"]
