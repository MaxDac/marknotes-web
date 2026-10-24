FROM node:26.12.0-bookworm-slim AS assets
WORKDIR /work/assets
COPY assets/package.json assets/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY assets/ ./
COPY priv/static/ /work/priv/static/
ARG APP_VERSION=""
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA
RUN npm run build
FROM caddy:2.11.6-alpine AS runtime
RUN apk add --no-cache jq && addgroup -S marknotes && adduser -S -G marknotes -u 10001 marknotes \
    && mkdir -p /srv && chown marknotes:marknotes /srv
ENV PORT=8080 SITE_ROOT=/srv XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
COPY Caddyfile /etc/caddy/Caddyfile
COPY deploy/start.sh /usr/local/bin/start
RUN chmod 755 /usr/local/bin/start
COPY --from=assets --chown=marknotes:marknotes /work/assets/dist/ /srv/
USER 10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start"]
