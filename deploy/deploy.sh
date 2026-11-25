#!/usr/bin/env bash
# Deploys or updates SmartZone on the server behind Caddy. Safe to re-run.
#
#   scp -i nova.pem deploy/* ubuntu@SERVER:/tmp/smartzone-deploy/
#   ssh -i nova.pem ubuntu@SERVER 'bash /tmp/smartzone-deploy/deploy.sh'
#
# Layout (same convention as the other apps on this server):
#   /opt/smartzone                      code (git clone of the GitHub repo) + .venv
#   /var/lib/smartzone/smartzone.env    device and admin keys (generated once, mode 600)
#   /var/lib/smartzone/smartzone.db     SQLite database
#   systemd unit smartzone.service      uvicorn on 127.0.0.1:8020
#   Caddy site smartzone.anshu.tech     HTTPS reverse proxy

set -euo pipefail

REPO="https://github.com/anshuu-prajapati/smartZone.git"
BRANCH="main"
APP=/opt/smartzone
DATA=/var/lib/smartzone
PORT=8020
DOMAIN=smartzone.anshu.tech
HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN=/opt/uv-python/cpython-3.12.16-linux-x86_64-gnu/bin/python3.12
AS_APP=(sudo -u smartzone -H env HOME="$DATA" UV_CACHE_DIR="$DATA/.uv-cache" UV_NO_CONFIG=1)
cd /

echo "==> user and directories"
id smartzone >/dev/null 2>&1 || sudo useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin smartzone
sudo install -d -o smartzone -g smartzone -m 750 "$DATA"
sudo install -d -o smartzone -g smartzone -m 755 "$APP"

echo "==> code"
if [ -d "$APP/.git" ]; then
  "${AS_APP[@]}" git -C "$APP" fetch --quiet origin "$BRANCH"
  "${AS_APP[@]}" git -C "$APP" reset --quiet --hard "origin/$BRANCH"
else
  "${AS_APP[@]}" git clone --quiet --branch "$BRANCH" "$REPO" "$APP"
fi
echo "    at $("${AS_APP[@]}" git -C "$APP" log -1 --format='%h %s')"

echo "==> python environment"
if [ ! -x "$APP/.venv/bin/python" ]; then
  "${AS_APP[@]}" uv venv --quiet --python "$PYTHON_BIN" "$APP/.venv"
fi
"${AS_APP[@]}" uv pip install --quiet --python "$APP/.venv/bin/python" -r "$APP/backend/requirements.txt"

echo "==> keys"
if ! sudo test -f "$DATA/smartzone.env"; then
  {
    echo "SMARTZONE_DEVICE_KEY=$(openssl rand -hex 16)"
    echo "SMARTZONE_ADMIN_KEY=$(openssl rand -hex 16)"
  } | sudo tee "$DATA/smartzone.env" >/dev/null
  echo "    generated new keys"
else
  echo "    keeping existing keys"
fi
sudo chown smartzone:smartzone "$DATA/smartzone.env"
sudo chmod 600 "$DATA/smartzone.env"

echo "==> systemd"
sudo install -m 644 "$HERE/smartzone.service" /etc/systemd/system/smartzone.service
sudo systemctl daemon-reload
sudo systemctl enable --quiet smartzone
sudo systemctl restart smartzone

for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/api/health" && echo

echo "==> caddy"
if sudo grep -q "^$DOMAIN {" /etc/caddy/Caddyfile; then
  echo "    site block already present"
else
  BACKUP="/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  sudo cp /etc/caddy/Caddyfile "$BACKUP"
  sudo tee -a /etc/caddy/Caddyfile <"$HERE/Caddyfile.smartzone" >/dev/null
  if ! sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "    Caddyfile invalid, restoring $BACKUP" >&2
    sudo cp "$BACKUP" /etc/caddy/Caddyfile
    exit 1
  fi
  sudo systemctl reload caddy
  echo "    added $DOMAIN (backup: $BACKUP)"
fi

echo "==> done: https://$DOMAIN"
