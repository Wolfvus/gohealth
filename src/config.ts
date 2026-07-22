import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const PORT = 3000;
export const REDIRECT_URI = "http://localhost:3000/oauth2/callback";
export const CREDENTIALS_PATH = process.env.GOOGLE_HEALTH_CREDENTIALS
  ?? resolve(".secrets/google-health-client.json");
export const TOKEN_PATH = ".secrets/google-health-tokens.json";
export const API_ROOT = "https://health.googleapis.com/v4";

export const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.ecg.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.irn.readonly",
  "https://www.googleapis.com/auth/googlehealth.location.readonly",
  "https://www.googleapis.com/auth/googlehealth.nutrition.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  "https://www.googleapis.com/auth/googlehealth.settings.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly"
] as const;

interface OAuthWebCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

export async function loadClientCredentials(): Promise<OAuthWebCredentials> {
  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("OAuth credentials were not found. Save them as .secrets/google-health-client.json or set GOOGLE_HEALTH_CREDENTIALS.");
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as { web?: Partial<OAuthWebCredentials> };
  const web = parsed.web;

  if (!web?.client_id || !web.client_secret) {
    throw new Error("Credential file does not contain OAuth web application credentials.");
  }
  if (!web.redirect_uris?.includes(REDIRECT_URI)) {
    throw new Error(`Credential file does not authorize ${REDIRECT_URI}.`);
  }

  return {
    client_id: web.client_id,
    client_secret: web.client_secret,
    redirect_uris: web.redirect_uris
  };
}
