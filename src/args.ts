export function parseDays(args: string[]): number {
  const index = args.indexOf("--days");
  if (index === -1) return 30;
  const raw = args[index + 1];
  const days = Number(raw);
  if (!raw || !Number.isInteger(days)) throw new Error("Usage: --days <integer>");
  return days;
}

export function shouldIncludeTcx(args: string[]): boolean {
  return !args.includes("--no-tcx");
}

export function shouldCompress(args: string[]): boolean {
  return !args.includes("--uncompressed");
}
