defmodule MarknotesWeb.PageControllerTest do
  use MarknotesWeb.ConnCase

  test "serves a browser-owned LiveView shell", %{conn: conn} do
    conn = get(conn, "/")
    html = html_response(conn, 200)
    assert html =~ "phx-update=\"ignore\""
    assert html =~ "data-dropbox="
    refute html =~ "SECRET_KEY_BASE"
    assert get_resp_header(conn, "cache-control") == ["no-store"]
  end

  test "CSP allows local attachment blob images but no remote images", %{conn: conn} do
    [csp] = conn |> get("/") |> get_resp_header("content-security-policy")
    assert csp =~ "img-src 'self' data: blob:;"
    refute csp =~ ~r/img-src[^;]*https?:/
  end

  test "CSP lets the sync core compile WebAssembly but allows no eval", %{conn: conn} do
    [csp] = conn |> get("/") |> get_resp_header("content-security-policy")
    assert csp =~ "script-src 'self' 'wasm-unsafe-eval';"
    refute csp =~ "'unsafe-eval'"
  end

  test "CSP limits connections to this origin and the sync providers", %{conn: conn} do
    [csp] = conn |> get("/") |> get_resp_header("content-security-policy")
    [_, connect] = Regex.run(~r/connect-src ([^;]*);/, csp)
    sources = String.split(connect)
    assert "'self'" in sources
    %URI{host: host, port: port} = MarknotesWeb.Endpoint.struct_url()
    assert "ws://#{host}:#{port}" in sources
    assert "https://api.dropboxapi.com" in sources
    assert "https://graph.microsoft.com" in sources
    refute "https:" in sources
    refute "ws:" in sources
    refute "wss:" in sources
    refute Enum.any?(sources, &(&1 =~ ~r{^https://\*\.?$}))
  end

  test "security page explains protections without scripts or user data", %{conn: conn} do
    conn = get(conn, "/security")
    html = html_response(conn, 200)
    assert html =~ "How MarkNotes protects your notes"
    assert html =~ "Encrypted with a passphrase"
    assert html =~ "Memory only"
    assert html =~ "Forget this device"
    assert html =~ "What this does not protect against"
    refute html =~ "<script"
    refute html =~ "csrf"
    assert [_] = get_resp_header(conn, "content-security-policy")
    assert get_resp_header(conn, "cache-control") == ["no-store"]
  end

  test "denies device and sensor APIs with a Permissions-Policy", %{conn: conn} do
    [policy] = conn |> get("/") |> get_resp_header("permissions-policy")

    for feature <- ~w(camera microphone geolocation payment usb) do
      assert policy =~ "#{feature}=()"
    end
  end

  test "the session cookie is HttpOnly, and Secure in production" do
    prod = Config.Reader.read!("config/prod.exs", env: :prod)
    refute Keyword.get(prod[:marknotes] || [], :secure_cookie) == false
    source = File.read!("lib/marknotes_web/endpoint.ex")
    assert source =~ "secure: Application.compile_env(:marknotes, :secure_cookie, true)"
    assert source =~ "http_only: true"
  end

  test "links and serves the shared MarkNotes icons", %{conn: conn} do
    html = conn |> get("/") |> html_response(200)
    assert html =~ ~s(href="/favicon.svg")
    assert html =~ ~s(href="/favicon.ico")
    assert html =~ ~s(rel="apple-touch-icon" href="/apple-touch-icon.png")
    assert html =~ ~s(rel="manifest" href="/site.webmanifest")
    assert html =~ ~s(src="/images/marknotes-mark.svg")

    for {path, type} <- [
          {"/favicon.svg", "image/svg+xml"},
          {"/favicon.ico", "image/vnd.microsoft.icon"},
          {"/apple-touch-icon.png", "image/png"},
          {"/icon-192.png", "image/png"},
          {"/icon-512.png", "image/png"},
          {"/site.webmanifest", "application/manifest+json"},
          {"/images/marknotes-mark.svg", "image/svg+xml"}
        ] do
      response = conn |> recycle() |> get(path)
      assert response.status == 200, path
      assert [content_type | _] = get_resp_header(response, "content-type")
      assert content_type =~ type, path
    end
  end

  # In prod `~p` digests paths (`/favicon-<hash>.svg`), but Plug.Static's `only:` list matches root files by exact
  # name, so digested root files 404. Only directories in static_paths may be linked through `~p`.
  test "root layout links only static directories through digested ~p paths" do
    source = File.read!("lib/marknotes_web/components/layouts/root.html.heex")
    dirs = Enum.reject(MarknotesWeb.static_paths(), &String.contains?(&1, "."))

    for [segment] <- Regex.scan(~r{~p"/([^/"?]+)}, source, capture: :all_but_first) do
      assert segment in dirs, "~p\"/#{segment}\" is a root file; link it with a plain href"
    end
  end

  test "health is database-free and reports version and revision", %{conn: conn} do
    previous = Application.get_env(:marknotes, :revision)
    on_exit(fn -> Application.put_env(:marknotes, :revision, previous) end)
    Application.put_env(:marknotes, :revision, "abc123")

    version = to_string(Application.spec(:marknotes, :vsn))
    health = conn |> get("/health") |> json_response(200)
    assert health == %{"status" => "ok", "version" => version, "revision" => "abc123"}
  end

  test "public provider configuration is runtime supplied and optional", %{conn: conn} do
    previous = Application.get_env(:marknotes, :providers)
    on_exit(fn -> Application.put_env(:marknotes, :providers, previous) end)
    Application.put_env(:marknotes, :providers, dropbox: "", onedrive: "")
    html = conn |> get("/") |> html_response(200)
    assert html =~ ~s(data-dropbox="")
    assert html =~ ~s(data-onedrive="")
    Application.put_env(:marknotes, :providers, dropbox: "public-key", onedrive: "public-id")
    html = conn |> recycle() |> get("/") |> html_response(200)
    assert html =~ ~s(data-dropbox="public-key")
    assert html =~ ~s(data-onedrive="public-id")
  end

  test "callbacks contain no user data or LiveView connection", %{conn: conn} do
    for provider <- ["dropbox", "onedrive"] do
      html = conn |> get("/oauth/#{provider}?code=private-code") |> html_response(200)
      refute html =~ "private-code"
      refute html =~ "csrf"
      assert html =~ "/assets/callback"
    end
  end
end
