#!/usr/bin/env bash
# Installs the Dugout daily download timer as a systemd *user* unit (no sudo).
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.config/systemd/user"
cp "$dir/dugout-daily-fetch.service" "$dir/dugout-daily-fetch.timer" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now dugout-daily-fetch.timer
systemctl --user list-timers dugout-daily-fetch.timer --no-pager
