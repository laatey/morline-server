FROM node:22-bookworm-slim

# CLI version and BuildKit frontend image MUST be the same version.
ARG RAILPACK_VERSION=0.37.0

ENV NODE_ENV=production \
    DATA_DIR=/data \
    RAILPACK_VERSION=${RAILPACK_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl gpg git python3 make g++ \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
    && curl -fsSLo /tmp/railpack.tar.gz "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    && tar -xzf /tmp/railpack.tar.gz -C /usr/local/bin railpack \
    && chmod 0755 /usr/local/bin/railpack \
    && rm -f /tmp/railpack.tar.gz \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /data \
    && chown -R node:node /app /data

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--no-warnings", "src/index.js"]
