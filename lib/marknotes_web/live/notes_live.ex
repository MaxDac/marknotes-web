defmodule MarknotesWeb.NotesLive do
  use MarknotesWeb, :live_view

  @impl true
  def mount(_params, _session, socket) do
    providers = Application.get_env(:marknotes, :providers, [])
    {:ok, assign(socket, :providers, providers)}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <main
      id="marknotes"
      phx-hook="Notes"
      phx-update="ignore"
      data-dropbox={@providers[:dropbox] || ""}
      data-onedrive={@providers[:onedrive] || ""}
    >
      <h1>MarkNotes</h1>
      <p>Loading your browser's notes...</p>
      <noscript>JavaScript and IndexedDB are required. Your notes stay in this browser.</noscript>
    </main>
    """
  end
end
