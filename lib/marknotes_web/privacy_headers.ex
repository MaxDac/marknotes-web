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

  # CodeMirror uses inline style attributes for layout, not inline scripts.
  defp policy do
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " <>
      "img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; " <>
      "frame-ancestors 'self'; form-action 'none'; " <>
      "connect-src 'self' ws: wss: https:; frame-src 'self' https://login.microsoftonline.com"
  end
end
