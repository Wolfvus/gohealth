import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Credentials } from "google-auth-library";
import { TOKEN_PATH } from "./config.js";

const absoluteTokenPath = resolve(TOKEN_PATH);

export async function loadTokens(): Promise<Credentials | null> {
  try {
    const raw = await readFile(absoluteTokenPath, "utf8");
    return JSON.parse(raw) as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveTokens(tokens: Credentials): Promise<void> {
  const directory = dirname(absoluteTokenPath);
  const temporaryPath = `${absoluteTokenPath}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, absoluteTokenPath);
  await chmod(absoluteTokenPath, 0o600);
}
