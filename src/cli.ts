import { spawn } from "node:child_process";
import { readdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const DASHBOARD_URL = "http://localhost:3001/d/gohealth-overview/gohealth-overview?orgId=1&from=now-30d&to=now&timezone=browser&kiosk";
const EXPORT_PATTERN = /^google-health-.*\.json(?:\.gz)?$/;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} failed${signal ? ` (${signal})` : ` with exit code ${code ?? "unknown"}`}.`));
    });
  });
}

function succeeds(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "ignore" });
    child.once("error", () => resolveCheck(false));
    child.once("exit", (code) => resolveCheck(code === 0));
  });
}

async function ensureDocker(): Promise<void> {
  if (await succeeds("docker", ["info"])) return;
  if (process.platform === "darwin" && await succeeds("colima", ["status"])) {
    process.stdout.write("Starting the local Colima Docker engine...\n");
    await run("colima", ["start"]);
  } else if (process.platform === "darwin" && await succeeds("which", ["colima"])) {
    process.stdout.write("Starting the local Colima Docker engine...\n");
    await run("colima", ["start"]);
  } else {
    throw new Error("Docker is not running. Start Docker Desktop or Colima, then retry.");
  }
  if (!await succeeds("docker", ["info"])) {
    throw new Error("The Docker engine did not become ready. Check `colima status` or Docker Desktop.");
  }
}

async function latestExport(): Promise<string | undefined> {
  const directory = resolve("data");
  const files = (await readdir(directory)).filter((name) => EXPORT_PATTERN.test(name));
  const dated = await Promise.all(files.map(async (name) => {
    const path = resolve(directory, name);
    return { path, modified: (await stat(path)).mtimeMs };
  }));
  dated.sort((left, right) => right.modified - left.modified);
  return dated[0]?.path;
}

async function keepOnlyLatestExport(): Promise<void> {
  const keep = await latestExport();
  if (!keep) return;
  const directory = resolve("data");
  const files = (await readdir(directory)).filter((name) => EXPORT_PATTERN.test(name));
  let removed = 0;
  for (const name of files) {
    const path = resolve(directory, name);
    if (path === keep) continue;
    await unlink(path);
    removed += 1;
  }
  process.stdout.write(`Kept newest export: ${keep}\nRemoved ${removed} superseded export${removed === 1 ? "" : "s"}.\n`);
}

async function start(): Promise<void> {
  await ensureDocker();
  await run("docker", ["compose", "up", "-d", "--wait"]);
  if (await latestExport()) {
    await run(process.execPath, ["--max-old-space-size=1024", "--import", "tsx", "src/dashboard-import.ts"]);
  }
  process.stdout.write(`\nGoHealth is ready:\n${DASHBOARD_URL}\n`);
}

async function refresh(days: string): Promise<void> {
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 3660) {
    throw new Error("Refresh days must be an integer from 1 to 3660.");
  }
  await ensureDocker();
  await run("docker", ["compose", "up", "-d", "--wait"]);
  await run(process.execPath, ["--import", "tsx", "src/export-cli.ts", "--days", days]);
  await run(process.execPath, ["--max-old-space-size=1024", "--import", "tsx", "src/dashboard-import.ts"]);
  await keepOnlyLatestExport();
  process.stdout.write(`\nDashboard refreshed:\n${DASHBOARD_URL}\n`);
}

async function openDashboard(): Promise<void> {
  if (process.platform === "darwin") await run("open", [DASHBOARD_URL]);
  else if (process.platform === "win32") await run("cmd", ["/c", "start", "", DASHBOARD_URL]);
  else await run("xdg-open", [DASHBOARD_URL]);
}

function usage(): string {
  return `goh — GoHealth dashboard

Usage:
  goh <command>

Commands:
  start            Start the dashboard
  stop             Stop the dashboard
  restart          Restart the dashboard
  refresh [days]   Pull and import data (default: 30 days)
  status           Show service status
  open             Open the insights dashboard
  auth             Renew Google authorization
  help             Show this help
`;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "start") await start();
  else if (command === "stop") await run("docker", ["compose", "down"]);
  else if (command === "restart") {
    await run("docker", ["compose", "down"]);
    await start();
  } else if (command === "refresh") await refresh(process.argv[3] ?? "30");
  else if (command === "status") await run("docker", ["compose", "ps"]);
  else if (command === "open") await openDashboard();
  else if (command === "auth") await run(process.execPath, ["--import", "tsx", "src/server.ts", ...process.argv.slice(3)]);
  else if (command === "help" || command === "--help" || command === "-h") process.stdout.write(usage());
  else throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "GoHealth command failed."}\n`);
  process.exitCode = 1;
});
