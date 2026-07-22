import { OAuth2Client, type Credentials } from "google-auth-library";
import { loadClientCredentials, REDIRECT_URI } from "./config.js";
import { loadTokens, saveTokens } from "./token-store.js";

export async function createOAuthClient(requireTokens = true): Promise<OAuth2Client> {
  const credentials = await loadClientCredentials();
  const client = new OAuth2Client(credentials.client_id, credentials.client_secret, REDIRECT_URI);
  const saved = await loadTokens();

  if (requireTokens && !saved) {
    throw new Error("No saved authorization. Run `goh auth` first.");
  }
  if (saved) client.setCredentials(saved);

  let current: Credentials = saved ?? {};
  client.on("tokens", (fresh) => {
    current = { ...current, ...fresh, refresh_token: fresh.refresh_token ?? current.refresh_token };
    void saveTokens(current).catch(() => {
      // Do not log token-bearing errors or token values.
      process.stderr.write("Could not persist refreshed OAuth tokens.\n");
    });
  });

  return client;
}

export async function exchangeAndSaveCode(client: OAuth2Client, code: string): Promise<void> {
  const previous = await loadTokens();
  const { tokens } = await client.getToken(code);
  const merged = {
    ...previous,
    ...tokens,
    refresh_token: tokens.refresh_token ?? previous?.refresh_token
  };
  if (!merged.refresh_token) {
    throw new Error("Google did not return a refresh token. Revoke prior app access and authorize again.");
  }
  client.setCredentials(merged);
  await saveTokens(merged);
}
