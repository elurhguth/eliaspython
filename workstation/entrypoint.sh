#!/bin/bash
set -e
# Home is a volume: make sure the bot user owns it.
mkdir -p /home/crew /home/crew/uploads /home/crew/Downloads
chown crew:crew /home/crew /home/crew/uploads /home/crew/Downloads
# Trust extra CA certs in Chromium too (NSS database).
if ls /usr/local/share/ca-certificates/extra/*.crt >/dev/null 2>&1; then
  su crew -c 'mkdir -p ~/.pki/nssdb && (certutil -d sql:$HOME/.pki/nssdb -L >/dev/null 2>&1 || certutil -d sql:$HOME/.pki/nssdb -N --empty-password)'
  for c in /usr/local/share/ca-certificates/extra/*.crt; do
    su crew -c "certutil -d sql:\$HOME/.pki/nssdb -A -t 'C,,' -n '$(basename "$c")' -i '$c'" || true
  done
fi
# Stale Chromium locks after an unclean shutdown would prevent it from starting.
rm -f /home/crew/.chromium/SingletonLock /home/crew/.chromium/SingletonSocket /home/crew/.chromium/SingletonCookie
if [ -z "$WORKSTATION_TOKEN" ]; then echo "WORKSTATION_TOKEN is required" >&2; exit 1; fi
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
