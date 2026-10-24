import Config

# Served over plain http: the session cookie cannot be `Secure` (it is in prod).
config :marknotes, secure_cookie: false

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :marknotes, MarknotesWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "10UYwZwxRTqPoUkGU4S6QWAhH7SdpOHIm+QbLOKLeOnn0x9a2UtNoqEEPy982QIQ",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Enable helpful, but potentially expensive runtime checks
config :phoenix_live_view,
  enable_expensive_runtime_checks: true

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true
