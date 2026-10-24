#!/bin/sh
set -eu

# Match marknotes-sync's rust-toolchain.toml and wasm-bindgen dependency.
rust=1.99.1
bindgen=0.2.129
rustup toolchain install "$rust" --profile minimal --target wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null 2>&1 ||
    [ "$(wasm-bindgen --version)" != "wasm-bindgen $bindgen" ]; then
    cargo "+$rust" install wasm-bindgen-cli --version "$bindgen" --locked --quiet
fi
