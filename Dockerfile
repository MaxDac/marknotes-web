FROM rust:1.99.1-slim-bookworm AS sync-toolchain
FROM node:24.21.0-bookworm-slim AS assets
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup RUSTUP_TOOLCHAIN=1.99.1
ENV PATH=/usr/local/cargo/bin:$PATH
COPY --from=sync-toolchain /usr/local/cargo/ /usr/local/cargo/
COPY --from=sync-toolchain /usr/local/rustup/ /usr/local/rustup/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates gcc libc6-dev pkg-config libssl-dev && apt-get clean
COPY deploy/install-sync-toolchain.sh /usr/local/bin/install-sync-toolchain
RUN sh /usr/local/bin/install-sync-toolchain
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
