# Crew web: static Next.js export served by Caddy (which also proxies /api and /vnc).
FROM node:22-bookworm-slim AS build
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN if ls /usr/local/share/ca-certificates/extra/*.crt >/dev/null 2>&1; then \
      cat /usr/local/share/ca-certificates/extra/*.crt > /usr/local/share/extra-ca.pem; \
    else touch /usr/local/share/extra-ca.pem; fi
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/extra-ca.pem NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @crew/web --include-workspace-root=false --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build --workspace @crew/web

FROM caddy:2-alpine
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/out /srv
EXPOSE 80 443
