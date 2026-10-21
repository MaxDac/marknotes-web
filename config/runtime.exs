import Config

config :marknotes, :providers,
  dropbox: System.get_env("DROPBOX_APP_KEY", "") |> String.trim(),
  onedrive: System.get_env("MSAL_CLIENT_ID", "") |> String.trim()

# Commit SHA baked into the release image (Dockerfile GIT_SHA); reported by /health.
config :marknotes, :revision, System.get_env("GIT_SHA", "unknown") |> String.trim()

if System.get_env("PHX_SERVER") do
  config :marknotes, MarknotesWeb.Endpoint, server: true
end

port = String.to_integer(System.get_env("PORT", "4000"))
config :marknotes, MarknotesWeb.Endpoint, http: [port: port]

if config_env() == :prod do
  host = System.get_env("PHX_HOST", "marknotes-web.fly.dev")
  local? = host in ["localhost", "127.0.0.1"]

  config :marknotes, MarknotesWeb.Endpoint,
    url: [
      host: host,
      port: if(local?, do: port, else: 443),
      scheme: if(local?, do: "http", else: "https")
    ],
    http: [ip: {0, 0, 0, 0, 0, 0, 0, 0}, port: port],
    secret_key_base: System.fetch_env!("SECRET_KEY_BASE")
end
