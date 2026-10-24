defmodule MarknotesWeb.Router do
  use MarknotesWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {MarknotesWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug MarknotesWeb.PrivacyHeaders
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", MarknotesWeb do
    pipe_through :browser

    live "/", NotesLive, :index
    get "/security", PageController, :security
  end

  scope "/", MarknotesWeb do
    get "/health", PageController, :health
    get "/oauth/:provider", PageController, :callback
  end

  # Other scopes may use custom stacks.
  # scope "/api", MarknotesWeb do
  #   pipe_through :api
  # end
end
