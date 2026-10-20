FROM node:24.21.0-bookworm-slim AS assets
WORKDIR /work/assets
COPY assets/package.json assets/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY assets/ ./
RUN npm run build

FROM elixir:1.20.4-otp-29-slim AS beam
RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates && apt-get clean

FROM beam AS build
ENV MIX_ENV=prod
WORKDIR /app
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
COPY config/ config/
RUN mix deps.get --only prod && mix deps.compile
COPY lib/ lib/
COPY priv/ priv/
COPY --from=assets /work/priv/static/assets/ priv/static/assets/
RUN mix compile --warnings-as-errors && mix phx.digest && mix release

FROM beam AS runtime
ENV LANG=C.UTF-8 PHX_SERVER=true PORT=8080 ERL_FLAGS="+S 2:2"
WORKDIR /app
RUN useradd --system --uid 10001 --home-dir /app marknotes
COPY --from=build --chown=marknotes:marknotes /app/_build/prod/rel/marknotes/ ./
USER marknotes
EXPOSE 8080
CMD ["bin/marknotes", "start"]
