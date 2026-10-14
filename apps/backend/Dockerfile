# Crew backend – one image, two roles: API server (default) and worker (`node dist/worker.js`).
FROM node:22-bookworm-slim AS base
# Optional extra CA certificates (corporate TLS-inspecting proxy). Put *.crt files in ./certs.
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN if ls /usr/local/share/ca-certificates/extra/*.crt >/dev/null 2>&1; then \
      cat /usr/local/share/ca-certificates/extra/*.crt > /usr/local/share/extra-ca.pem; \
    else touch /usr/local/share/extra-ca.pem; fi
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/extra-ca.pem

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/
RUN npm ci --workspace @crew/backend --include-workspace-root=false --no-audit --no-fund
COPY apps/backend apps/backend
RUN npm run build --workspace @crew/backend \
 && npm prune --omit=dev --workspace @crew/backend --include-workspace-root=false

FROM base
ENV NODE_ENV=production DATA_DIR=/data
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/backend /app/apps/backend
WORKDIR /app/apps/backend
RUN rm -rf src && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4000
CMD ["node", "dist/server.js"]
