FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.157.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 DATA_DIR=/app/data \
    CODEX_BIN=/usr/local/lib/node_modules/@openai/codex/bin/codex.js
USER node
VOLUME ["/app/data"]
EXPOSE 3210
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
