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
