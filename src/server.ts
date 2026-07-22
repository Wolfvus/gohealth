import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { parseDays, shouldCompress, shouldIncludeTcx } from "./args.js";
import { createOAuthClient, exchangeAndSaveCode } from "./auth.js";
import { PORT, REDIRECT_URI, SCOPES } from "./config.js";
import { exportHealthData } from "./exporter.js";

async function main(): Promise<void> {
  const client = await createOAuthClient(false);
  const state = randomBytes(32).toString("hex");
  const args = process.argv.slice(2);
  const app = express();

  const authorizeUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [...SCOPES],
    state
  });

  app.get("/", (_request, response) => {
    response.type("html").send('<h1>Google Health local exporter</h1><p><a href="/auth">Authorize and export data</a></p>');
  });
  app.get("/auth", (_request, response) => response.redirect(authorizeUrl));
  app.get("/oauth2/callback", async (request, response) => {
    const code = typeof request.query.code === "string" ? request.query.code : undefined;
    const returnedState = typeof request.query.state === "string" ? request.query.state : "";
    const expected = Buffer.from(state);
    const actual = Buffer.from(returnedState);
    if (!code || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.status(400).send("Invalid OAuth callback. Return to the terminal and restart authorization.");
      return;
    }

    try {
      await exchangeAndSaveCode(client, code);
      response.type("html").send("<h1>Authorization complete</h1><p>The local export is running. You may close this tab.</p>");
      const outputPath = await exportHealthData(client, {
        days: parseDays(args),
        includeTcx: shouldIncludeTcx(args),
        compress: shouldCompress(args)
      });
      process.stdout.write(`Export saved to ${outputPath}\n`);
      server.close();
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).send("Authorization or export failed. See the terminal for a sanitized error.");
      }
      const message = error instanceof Error ? error.message : "Authorization or export failed.";
      process.stderr.write(`${message}\n`);
    }
  });

  const server = app.listen(PORT, () => {
    process.stdout.write(`Local server listening at http://localhost:${PORT}\n`);
    process.stdout.write(`Open http://localhost:${PORT}/auth to authorize Google Health access.\n`);
    process.stdout.write(`OAuth callback: ${REDIRECT_URI}\n`);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Server failed to start.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
