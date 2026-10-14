#!/bin/bash
# Headful Chromium on the virtual display, controlled over CDP (localhost only).
CHROME=$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)
exec "${CHROME:-chromium}" \
  --user-data-dir=/home/crew/.chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage \
  --no-sandbox --test-type \
  --password-store=basic \
  --window-position=0,0 \
  --window-size=${SCREEN_WIDTH:-1280},${SCREEN_HEIGHT:-800} \
  --start-maximized \
  --lang=${BROWSER_LANG:-sv-SE} \
  ${CHROMIUM_PROXY:+--proxy-server=$CHROMIUM_PROXY} \
  about:blank
