#!/bin/sh
set -eu
image="${1:?Usage: test-container.sh image [expected-revision] [expected-version]}"
revision="${2:-}"
version="${3:-}"
name="marknotes-contracts-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --memory=256m --cpus=1 -p 127.0.0.1::8080 \
  -e DROPBOX_APP_KEY=' override"\key ' -e MSAL_CLIENT_ID= "$image" >/dev/null
mapping="$(docker port "$name" 8080/tcp)" || { docker logs "$name"; exit 1; }
port="$(printf '%s' "$mapping" | sed 's/.*://')"
test -n "$port"
origin="http://127.0.0.1:$port"
ready=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "$origin/health" > /dev/null; then ready=yes; break; fi
  echo "Waiting for container ($attempt/10)..."
  sleep 1
done
if [ -z "$ready" ]; then docker logs "$name"; exit 1; fi
curl -fsS "$origin/config.json" | docker exec -i "$name" jq -e '.schema == 1 and .dropbox == "override\"\\key" and .onedrive == ""' >/dev/null
curl -fsS "$origin/health" | docker exec -i "$name" jq -e --arg revision "$revision" --arg version "$version" \
  '.status == "ok" and (.version | type == "string" and length > 0) and (.revision | type == "string" and length > 0) and ($revision == "" or .revision == $revision) and ($version == "" or .version == $version)' >/dev/null
curl -fsS "$origin/sw.js" >/dev/null
curl -fsS "$origin/security" >/dev/null
curl -fsS "$origin/oauth/onedrive" >/dev/null
test "$(curl -s -o /dev/null -w '%{http_code}' "$origin/oauth/unknown")" = 404
test "$(docker inspect --format '{{.Config.User}}' "$name")" = 10001
docker exec "$name" sh -c '! command -v node && ! command -v erl'
echo "Container contracts passed."
