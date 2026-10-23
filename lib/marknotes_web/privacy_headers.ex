defmodule MarknotesWeb.PrivacyHeaders do
  @moduledoc false
  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    conn
    |> put_resp_header("cache-control", "no-store")
    |> put_resp_header("referrer-policy", "no-referrer")
    |> put_resp_header("x-content-type-options", "nosniff")
    |> put_resp_header("content-security-policy", policy())
  end

  # Browser code talks only to this origin (LiveView socket) and the provider APIs it syncs with; see
  # docs/security.md. Keep this list in sync with the download host check in assets/js/providers.ts.
  @providers ~w(
    https://api.dropboxapi.com
    https://content.dropboxapi.com
    https://graph.microsoft.com
    https://login.microsoftonline.com
    https://*.1drv.com
    https://*.microsoftpersonalcontent.com
    https://*.sharepoint.com
  )

  # CodeMirror uses inline style attributes for layout, not inline scripts.
  # 'wasm-unsafe-eval' lets the shared sync core (@marknotes/sync) compile its WebAssembly.
  @doc false
  def policy do
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " <>
      "style-src 'self' 'unsafe-inline'; " <>
      "img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; " <>
      "frame-ancestors 'self'; form-action 'none'; " <>
      "connect-src #{Enum.join(["'self'", socket_origin() | @providers], " ")}; " <>
      "frame-src 'self' https://login.microsoftonline.com"
  end

  # Older browsers do not let 'self' match the LiveView WebSocket, so allow its origin explicitly.
  defp socket_origin do
    %URI{scheme: scheme, host: host, port: port} = MarknotesWeb.Endpoint.struct_url()
    ws = if scheme == "https", do: "wss", else: "ws"
    default? = port in [nil, 80, 443]
    if default?, do: "#{ws}://#{host}", else: "#{ws}://#{host}:#{port}"
  end
end
