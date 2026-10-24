#!/bin/sh
set -eu

# Serialize public IDs as JSON, never as executable script or interpolated HTML.
jq -n \
  --arg dropbox "${DROPBOX_APP_KEY-sdjefhss3elcfp3}" \
  --arg onedrive "${MSAL_CLIENT_ID-b923171e-d03d-4e85-9c01-4909c902a82c}" \
  '{schema: 1, dropbox: ($dropbox | gsub("^\\s+|\\s+$"; "")), onedrive: ($onedrive | gsub("^\\s+|\\s+$"; ""))}' \
  > "$SITE_ROOT/config.json.tmp"
mv "$SITE_ROOT/config.json.tmp" "$SITE_ROOT/config.json"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
