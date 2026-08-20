# Suvidha - single-image deployment.
#
# Builds the frontend and serves it from the same Node process as the API and
# the WebSocket, so the whole app runs behind one origin with no CORS and no
# VITE_SERVER_URL to configure. Works on Railway, Fly.io, Cloud Run, or any
# host that can keep a container running.

FROM node:22-alpine

WORKDIR /app

# Install with the lockfile first so this layer caches across source changes.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .

# The server auto-detects web/dist and serves it.
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["npm", "start"]
