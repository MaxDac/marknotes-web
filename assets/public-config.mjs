export function publicConfig(env) {
  return {
    schema: 1,
    dropbox: (env.DROPBOX_APP_KEY ?? "sdjefhss3elcfp3").trim(),
    onedrive: (
      env.MSAL_CLIENT_ID ?? "b923171e-d03d-4e85-9c01-4909c902a82c"
    ).trim(),
  };
}
