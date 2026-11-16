#!/usr/bin/env bash
# Installs the Dugout daily download timer as a systemd *user* unit (no sudo).
# The .service file is a template: @WORKDIR@, @PATH@ and @NPM@ are filled in here.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$dir/../.." && pwd)"
npm="$(command -v npm || true)"
if [ -z "$npm" ]; then
	echo "npm not found in PATH" >&2
	exit 1
fi
path="$(dirname "$npm"):/usr/local/bin:/usr/bin:/bin"
out="$HOME/.config/systemd/user"
mkdir -p "$out"
sed -e "s|@WORKDIR@|$repo|g" -e "s|@PATH@|$path|g" -e "s|@NPM@|$npm|g" \
	"$dir/dugout-daily-fetch.service" >"$out/dugout-daily-fetch.service"
cp "$dir/dugout-daily-fetch.timer" "$out/"
systemctl --user daemon-reload
systemctl --user enable --now dugout-daily-fetch.timer
systemctl --user list-timers dugout-daily-fetch.timer --no-pager
