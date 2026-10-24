#!/bin/sh
set -eu
version=2.11.2
destination="${1:?Usage: install-caddy.sh destination}"
mkdir -p "$destination"
destination="$(cd "$destination" && pwd)"
temporary="$(mktemp -d)"
trap 'rm -f "$temporary/caddy.tar.gz" "$temporary/checksums.txt" "$temporary/expected"; rmdir "$temporary"' EXIT
base="https://github.com/caddyserver/caddy/releases/download/v$version"
archive="caddy_${version}_linux_amd64.tar.gz"
curl --fail --silent --show-error --location "$base/$archive" -o "$temporary/caddy.tar.gz"
curl --fail --silent --show-error --location "$base/caddy_${version}_checksums.txt" -o "$temporary/checksums.txt"
awk -v name="$archive" '$2 == name {print $1 "  caddy.tar.gz"}' "$temporary/checksums.txt" > "$temporary/expected"
test -s "$temporary/expected"
(cd "$temporary" && sha512sum --check expected)
tar -xzf "$temporary/caddy.tar.gz" -C "$destination" caddy
