# Crew workstation – the bots' shared computer.
# Ubuntu + Playwright's Chromium (persistent profile) + Xvfb + noVNC (live view / takeover) + toold (tool API).
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble

FROM ${PLAYWRIGHT_IMAGE} AS base
# Optional: override the Ubuntu apt mirror, e.g. --build-arg UBUNTU_MIRROR=https://se.archive.ubuntu.com
ARG UBUNTU_MIRROR=""
RUN rm -f /etc/apt/sources.list.d/nodesource.list; \
    if [ -n "$UBUNTU_MIRROR" ]; then sed -i -E "s#https?://([a-z0-9.-]+\.)?archive\.ubuntu\.com/ubuntu#${UBUNTU_MIRROR}/ubuntu#g" /etc/apt/sources.list.d/ubuntu.sources; fi
# Optional extra CA certificates (e.g. a corporate TLS-inspecting proxy). Put *.crt files in ./certs.
# When present, apt is switched to HTTPS mirrors and told to trust them.
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN set -e; if ls /usr/local/share/ca-certificates/extra/*.crt >/dev/null 2>&1; then \
      cat /usr/local/share/ca-certificates/extra/*.crt > /usr/local/share/extra-ca.pem; \
      cat /usr/local/share/extra-ca.pem >> /etc/ssl/certs/ca-certificates.crt; \
      sed -i 's#http://#https://#g' /etc/apt/sources.list.d/*.sources 2>/dev/null || true; \
      echo 'Acquire::https::CAInfo "/etc/ssl/certs/ca-certificates.crt";' > /etc/apt/apt.conf.d/99extra-ca; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

FROM base AS build
WORKDIR /src
COPY workstation/toold/package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.base.json /tsconfig.base.json
COPY workstation/toold/tsconfig.json ./
RUN sed -i 's#../../tsconfig.base.json#/tsconfig.base.json#' tsconfig.json
COPY workstation/toold/src ./src
RUN npx tsc -p . && npm prune --omit=dev

FROM base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc python3-websockify supervisor \
      fonts-dejavu fonts-liberation fonts-noto-color-emoji \
      ca-certificates curl wget git jq unzip zip python3 python3-pip python3-venv \
      procps less nano libnss3-tools \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-*
# Unprivileged user that the bots work as.
RUN useradd -m -u 1500 -s /bin/bash crew
COPY --from=build /src/dist /opt/toold/dist
COPY --from=build /src/node_modules /opt/toold/node_modules
COPY --from=build /src/package.json /opt/toold/package.json
COPY workstation/supervisord.conf /etc/supervisor/conf.d/crew.conf
COPY workstation/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY workstation/start-chromium.sh /usr/local/bin/start-chromium.sh
COPY workstation/crew-view.html /usr/share/novnc/crew-view.html
RUN chmod +x /usr/local/bin/*.sh && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html
ENV DISPLAY=:99 \
    SCREEN_WIDTH=1280 SCREEN_HEIGHT=800 \
    CREW_HOME=/home/crew
VOLUME ["/home/crew"]
EXPOSE 7000 6080
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s CMD curl -fsS http://127.0.0.1:7000/health || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
