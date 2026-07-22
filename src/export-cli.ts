import { parseDays, shouldCompress, shouldIncludeTcx } from "./args.js";
import { createOAuthClient } from "./auth.js";
import { exportHealthData } from "./exporter.js";

async function main(): Promise<void> {
  const client = await createOAuthClient();
  const outputPath = await exportHealthData(client, {
    days: parseDays(process.argv.slice(2)),
    includeTcx: shouldIncludeTcx(process.argv.slice(2)),
    compress: shouldCompress(process.argv.slice(2))
  });
  process.stdout.write(`Export saved to ${outputPath}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Export failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
