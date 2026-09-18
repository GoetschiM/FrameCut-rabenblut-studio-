#!/usr/bin/env bash
# Runs ON the LXC as the deploy SSH user. Pulls the latest main and restarts
# the service. Invoked by .github/workflows/deploy.yml on every push to main.
set -euo pipefail

cd /opt/framecut

git fetch origin main
git reset --hard origin/main

sudo /usr/bin/systemctl restart framecut
sudo /usr/bin/systemctl --no-pager status framecut
