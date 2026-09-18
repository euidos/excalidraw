# Boards storage backend. Built on dev-woo and shipped to euidos-internal with
# `docker save | ssh root@euidos-internal docker load` (the host has no registry
# credentials).
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# deps first, so a source change does not re-resolve the tree
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY migrations/ ./migrations/

USER node
EXPOSE 3000
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/api/health" | grep -q '"ok":true'

CMD ["node", "src/server.js"]
