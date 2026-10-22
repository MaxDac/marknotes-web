defmodule MarknotesWeb.PageController do
  use MarknotesWeb, :controller

  def health(conn, _params) do
    json(conn, %{
      status: "ok",
      version: to_string(Application.spec(:marknotes, :vsn)),
      revision: Application.get_env(:marknotes, :revision, "unknown")
    })
  end

  # The body interpolates only a static verified route, never request data.
  # sobelow_skip ["XSS.SendResp"]
  def callback(conn, %{"provider" => provider}) when provider in ["dropbox", "onedrive"] do
    conn
    |> MarknotesWeb.PrivacyHeaders.call([])
    |> put_resp_content_type("text/html")
    |> send_resp(200, """
    <!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="referrer" content="no-referrer"><title>MarkNotes sign-in</title>
    <script type="module" src="#{~p"/assets/callback.js"}"></script></head>
    <body>Completing sign-in. You can close this window when finished.</body></html>
    """)
  end

  def callback(conn, _params), do: send_resp(conn, 404, "Unknown provider")
end
