#!/usr/bin/env bash
# Deploys the committed FrameCut server/frontend to the Proxmox container and syncs
# the worker code into the laptop's running worker folder. Only committed, tested
# code goes live; a failed health check restores the previous files automatically.
#
#   scripts/deploy-live.sh            # server + worker code
#   scripts/deploy-live.sh --server   # server/frontend only
#   scripts/deploy-live.sh --worker   # worker code only
set -euo pipefail
cd "$(dirname "$0")/.."

PVE_HOST="${FRAMECUT_PVE:-root@pve01}"
CT_ID="${FRAMECUT_CT:-116}"
APP_DIR="${FRAMECUT_APP_DIR:-/opt/framecut}"
WORKER_RUN_DIR="${FRAMECUT_WORKER_DIR:-C:/Users/Miche/Documents/ChatGPT/Moto Poschung/rabenblut-studio/worker}"
MODE="${1:-all}"

deploy_server=1; deploy_worker=1
case "$MODE" in
  all) ;;
  --server) deploy_worker=0 ;;
  --worker) deploy_server=0 ;;
  *) echo "Usage: $0 [--server|--worker]" >&2; exit 2 ;;
esac

if [ -n "$(git status --porcelain -- server.mjs lib public worker test)" ]; then
  echo "Abbruch: nicht committete Aenderungen in server.mjs/lib/public/worker/test. Zuerst committen." >&2
  git status --short -- server.mjs lib public worker test >&2
  exit 1
fi

echo "== Tests"
node --test test/*.test.mjs
for file in server.mjs lib/*.mjs public/*.js; do node --check "$file"; done

COMMIT="$(git rev-parse --short HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
echo "== Commit $COMMIT ($STAMP)"

if [ "$deploy_server" = 1 ]; then
  mapfile -t SERVER_FILES < <(git ls-files server.mjs lib public)
  BUNDLE="$(mktemp -d)/framecut-$COMMIT.tgz"
  tar --owner=0 --group=0 -czf "$BUNDLE" "${SERVER_FILES[@]}"
  scp -q "$BUNDLE" "$PVE_HOST:/tmp/framecut-$COMMIT.tgz"
  ssh "$PVE_HOST" "pct push $CT_ID /tmp/framecut-$COMMIT.tgz /tmp/framecut-$COMMIT.tgz"
  ssh "$PVE_HOST" "pct exec $CT_ID -- bash -s" <<REMOTE
set -euo pipefail
cd "$APP_DIR"
mkdir -p backups
BACKUP="backups/deploy-$STAMP.tgz"
tar -czf "\$BACKUP" $(printf '%q ' "${SERVER_FILES[@]}") 2>/dev/null || tar -czf "\$BACKUP" server.mjs lib public
tar --no-same-owner -xzf "/tmp/framecut-$COMMIT.tgz" -C "$APP_DIR"
chown -R framecut:framecut public
restore() {
  echo "Health-Check fehlgeschlagen - stelle \$BACKUP wieder her" >&2
  tar --no-same-owner -xzf "\$BACKUP" -C "$APP_DIR"
  systemctl restart framecut.service
  exit 1
}
/usr/local/bin/node --check server.mjs || restore
systemctl restart framecut.service
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code="\$(/usr/local/bin/node -e "fetch('http://127.0.0.1:4317/api/queue').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('0'))" || true)"
  [ "\$code" = 401 ] && break
  sleep 2
done
[ "\$code" = 401 ] || restore
systemctl is-active --quiet framecut.service || restore
echo "$COMMIT $STAMP" > DEPLOYED_COMMIT
rm -f "/tmp/framecut-$COMMIT.tgz"
echo "Server live: $COMMIT (Backup: \$BACKUP)"
REMOTE
fi

if [ "$deploy_worker" = 1 ]; then
  mapfile -t WORKER_FILES < <(git ls-files worker | grep -Ev '^worker/(releases|installer)/|^worker/worker\.version\.json$|\.example\.json$')
  WORKER_BACKUP="$WORKER_RUN_DIR/data/backups/deploy-$STAMP"
  mkdir -p "$WORKER_BACKUP"
  for file in "${WORKER_FILES[@]}"; do
    relative="${file#worker/}"
    target="$WORKER_RUN_DIR/$relative"
    if [ -f "$target" ]; then mkdir -p "$WORKER_BACKUP/$(dirname "$relative")"; cp -p "$target" "$WORKER_BACKUP/$relative"; fi
    mkdir -p "$(dirname "$target")"
    cp -p "$file" "$target"
  done
  echo "$COMMIT $STAMP" > "$WORKER_RUN_DIR/data/DEPLOYED_COMMIT"
  echo "Worker-Code synchronisiert: $COMMIT (Backup: $WORKER_BACKUP)"
  echo "Hinweis: laufender Worker laedt den neuen Code erst nach einem Neustart."
fi
