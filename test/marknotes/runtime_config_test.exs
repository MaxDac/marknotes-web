defmodule Marknotes.RuntimeConfigTest do
  use ExUnit.Case, async: false

  @provider_env ~w(DROPBOX_APP_KEY MSAL_CLIENT_ID)

  setup do
    previous = Map.new(@provider_env, &{&1, System.get_env(&1)})
    Enum.each(@provider_env, &System.delete_env/1)

    on_exit(fn ->
      Enum.each(previous, fn
        {name, nil} -> System.delete_env(name)
        {name, value} -> System.put_env(name, value)
      end)
    end)

    :ok
  end

  test "uses the public application IDs when environment overrides are absent" do
    providers = providers()

    assert providers[:dropbox] == "sdjefhss3elcfp3"
    assert providers[:onedrive] == "b923171e-d03d-4e85-9c01-4909c902a82c"
  end

  test "uses trimmed environment overrides instead of the defaults" do
    System.put_env("DROPBOX_APP_KEY", " custom-dropbox \n")
    System.put_env("MSAL_CLIENT_ID", "\tcustom-onedrive ")

    providers = providers()

    assert providers[:dropbox] == "custom-dropbox"
    assert providers[:onedrive] == "custom-onedrive"
  end

  test "explicit empty values disable both providers" do
    Enum.each(@provider_env, &System.put_env(&1, ""))

    assert providers() == [dropbox: "", onedrive: ""]
  end

  test "whitespace-only values disable both providers" do
    Enum.each(@provider_env, &System.put_env(&1, " \t\n"))

    assert providers() == [dropbox: "", onedrive: ""]
  end

  test "disabling one provider preserves the other provider's default" do
    System.put_env("DROPBOX_APP_KEY", "")
    assert providers()[:onedrive] == "b923171e-d03d-4e85-9c01-4909c902a82c"

    System.delete_env("DROPBOX_APP_KEY")
    System.put_env("MSAL_CLIENT_ID", "")
    assert providers()[:dropbox] == "sdjefhss3elcfp3"
  end

  defp providers do
    "config/runtime.exs"
    |> Config.Reader.read!(env: :test)
    |> Keyword.fetch!(:marknotes)
    |> Keyword.fetch!(:providers)
  end
end
