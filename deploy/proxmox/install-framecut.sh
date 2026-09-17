#!/usr/bin/env bash
set -euo pipefail

# Run inside a fresh Debian 12 LXC, after copying the FrameCut app to /opt/framecut.
# The data directory is deliberately separate from the application code.
apt-get update
apt-get install -y nodejs npm rsync
id -u framecut >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin framecut
install -d -o framecut -g framecut /srv/framecut-data/uploads /srv/framecut-data/backups
chown -R framecut:framecut /opt/framecut /srv/framecut-data
install -m 0644 /opt/framecut/deploy/proxmox/framecut.service /etc/systemd/system/framecut.service
systemctl daemon-reload
systemctl enable --now framecut.service
systemctl status framecut.service --no-pager
