#!/bin/sh
set -eu

work_dir="${WORK_DIR:-/app/workspace}"
config_dir="$work_dir/.polpo"
config_file="$config_dir/polpo.json"
default_config="/app/default-polpo.json"

mkdir -p "$config_dir"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$work_dir" 2>/dev/null || true
fi

if [ ! -f "$config_file" ]; then
  cp "$default_config" "$config_file"
fi

exec "$@"
