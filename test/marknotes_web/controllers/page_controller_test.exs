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

  test "health is database-free", %{conn: conn} do
    assert conn |> get("/health") |> json_response(200) == %{"status" => "ok"}
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
