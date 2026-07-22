import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { OAuth2Client } from "google-auth-library";
import { API_ROOT } from "./config.js";

type TimeKind = "interval" | "sample" | "daily" | "session" | "sleep" | "ecg" | "none";
type ReadMethod = "list" | "reconcile";

const DATA_TYPES: ReadonlyArray<readonly [string, TimeKind, ReadMethod?]> = [
  ["active-energy-burned", "interval"], ["active-minutes", "interval"],
  ["active-zone-minutes", "interval"], ["activity-level", "interval"],
  ["altitude", "interval"], ["basal-energy-burned", "interval"],
  ["blood-glucose", "sample"], ["body-fat", "sample"],
  ["core-body-temperature", "sample"], ["daily-heart-rate-variability", "daily"],
  ["daily-heart-rate-zones", "daily"], ["daily-oxygen-saturation", "daily"],
  ["daily-respiratory-rate", "daily"], ["daily-resting-heart-rate", "daily"],
  ["daily-sleep-temperature-derivations", "daily"], ["daily-vo2-max", "daily"],
  ["distance", "interval"], ["electrocardiogram", "ecg"],
  ["exercise", "session"], ["floors", "interval", "reconcile"],
  ["food-measurement-unit", "none"], ["heart-rate", "sample"],
  ["heart-rate-variability", "sample"], ["height", "sample"],
  ["hydration-log", "session"], ["irregular-rhythm-notification", "interval"],
  ["nutrition-log", "session"], ["oxygen-saturation", "sample"],
  ["respiratory-rate-sleep-summary", "sample"], ["run-vo2-max", "sample"],
  ["sedentary-period", "interval"], ["sleep", "sleep"], ["steps", "interval"],
  ["swim-lengths-data", "interval"], ["time-in-heart-rate-zone", "interval"],
  ["vo2-max", "sample"], ["weight", "sample"]
];

const DAILY_ROLLUP_TYPES = ["calories-in-heart-rate-zone", "total-calories"] as const;

interface ApiFailure {
  error: { status?: number; message: string };
}

interface ExportOptions {
  days: number;
  includeTcx?: boolean;
  compress?: boolean;
}

const gzipAsync = promisify(gzip);

function appendAll<T>(target: T[], source: T[]): void {
  // Avoid target.push(...source): large heart-rate result sets can exceed
  // JavaScript's maximum function-argument/call-stack limit.
  for (const item of source) target.push(item);
}

function snakeCase(value: string): string {
  return value.replaceAll("-", "_");
}

function range(days: number): { start: Date; end: Date; startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  return {
    start,
    end,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

function chunks(start: Date, end: Date, maximumDays: number): Array<{ start: Date; end: Date }> {
  const result: Array<{ start: Date; end: Date }> = [];
  let cursor = start;
  while (cursor < end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + maximumDays * 86_400_000, end.getTime()));
    result.push({ start: cursor, end: chunkEnd });
    cursor = chunkEnd;
  }
  return result;
}

function dateParts(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) throw new Error("Invalid date.");
  return { year, month, day };
}

function filterFor(dataType: string, kind: TimeKind, dates: ReturnType<typeof range>): string | undefined {
  const field = snakeCase(dataType);
  if (kind === "none") return undefined;
  if (kind === "daily") return `${field}.date >= "${dates.startDate}" AND ${field}.date < "${dates.endDate}"`;
  if (kind === "sample") {
    return `${field}.sample_time.physical_time >= "${dates.start.toISOString()}" AND ${field}.sample_time.physical_time < "${dates.end.toISOString()}"`;
  }
  if (kind === "sleep") {
    return `sleep.interval.end_time >= "${dates.start.toISOString()}" AND sleep.interval.end_time < "${dates.end.toISOString()}"`;
  }
  if (kind === "session") {
    return `${field}.interval.civil_start_time >= "${dates.startDate}" AND ${field}.interval.civil_start_time < "${dates.endDate}"`;
  }
  if (kind === "ecg") return `electrocardiogram.interval.start_time >= "${dates.start.toISOString()}"`;
  return `${field}.interval.start_time >= "${dates.start.toISOString()}" AND ${field}.interval.start_time < "${dates.end.toISOString()}"`;
}

function safeFailure(error: unknown): ApiFailure {
  const value = error as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
  const apiMessage = value.response?.data?.error?.message;
  return { error: { status: value.response?.status, message: apiMessage ?? value.message ?? "Unknown API error" } };
}

async function getJson(client: OAuth2Client, url: string, params?: Record<string, string | number>): Promise<unknown> {
  const response = await client.request<unknown>({ url, params, headers: { Accept: "application/json" } });
  return response.data;
}

async function postJson(client: OAuth2Client, url: string, data: unknown): Promise<unknown> {
  const response = await client.request<unknown>({
    url,
    method: "POST",
    data,
    headers: { Accept: "application/json", "Content-Type": "application/json" }
  });
  return response.data;
}

async function getOptional(client: OAuth2Client, path: string): Promise<unknown | ApiFailure> {
  try {
    return await getJson(client, `${API_ROOT}/${path}`);
  } catch (error) {
    return safeFailure(error);
  }
}

async function getPaged(
  client: OAuth2Client,
  path: string,
  itemKey: string,
  params: Record<string, string | number>
): Promise<unknown[] | ApiFailure> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  try {
    do {
      const data = await getJson(client, `${API_ROOT}/${path}`, { ...params, ...(pageToken ? { pageToken } : {}) }) as
        Record<string, unknown>;
      const pageItems = data[itemKey];
      if (Array.isArray(pageItems)) appendAll(items, pageItems);
      const nextPageToken = typeof data.nextPageToken === "string" && data.nextPageToken
        ? data.nextPageToken
        : undefined;
      if (nextPageToken && seenPageTokens.has(nextPageToken)) {
        throw new Error("The API repeated a pagination token; pagination was stopped safely.");
      }
      if (nextPageToken) seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    } while (pageToken);
    return items;
  } catch (error) {
    return safeFailure(error);
  }
}

async function getDataType(
  client: OAuth2Client,
  dataType: string,
  kind: TimeKind,
  method: ReadMethod,
  dates: ReturnType<typeof range>
): Promise<unknown[] | ApiFailure | { dataPoints: unknown[]; errors: ApiFailure[] }> {
  if (kind === "none" || kind === "ecg") {
    const filter = filterFor(dataType, kind, dates);
    return getPaged(client, `users/me/dataTypes/${dataType}/dataPoints${method === "reconcile" ? ":reconcile" : ""}`,
      "dataPoints", { pageSize: 10_000, ...(filter ? { filter } : {}) });
  }

  const maximumDays = dataType === "heart-rate" || dataType === "active-minutes" ? 14 : 90;
  const dataPoints: unknown[] = [];
  const errors: ApiFailure[] = [];
  for (const chunk of chunks(dates.start, dates.end, maximumDays)) {
    const chunkDates = {
      start: chunk.start,
      end: chunk.end,
      startDate: chunk.start.toISOString().slice(0, 10),
      endDate: chunk.end.toISOString().slice(0, 10)
    };
    const filter = filterFor(dataType, kind, chunkDates);
    const result = await getPaged(
      client,
      `users/me/dataTypes/${dataType}/dataPoints${method === "reconcile" ? ":reconcile" : ""}`,
      "dataPoints",
      { pageSize: dataType === "sleep" || dataType === "exercise" ? 25 : 10_000, ...(filter ? { filter } : {}) }
    );
    if (Array.isArray(result)) appendAll(dataPoints, result);
    else errors.push(result);
  }
  return errors.length ? { dataPoints, errors } : dataPoints;
}

async function getDailyRollup(
  client: OAuth2Client,
  dataType: string,
  dates: ReturnType<typeof range>
): Promise<unknown[] | ApiFailure | { rollupDataPoints: unknown[]; errors: ApiFailure[] }> {
  const rollupDataPoints: unknown[] = [];
  const errors: ApiFailure[] = [];
  const civilStart = new Date(`${dates.startDate}T00:00:00Z`);
  const civilEnd = new Date(`${dates.endDate}T00:00:00Z`);
  // The service currently rejects a closed-open span of exactly 14 days despite
  // documenting a 14-day maximum, so use 13-day chunks for compatibility.
  for (const chunk of chunks(civilStart, civilEnd, 13)) {
    try {
      const data = await postJson(client, `${API_ROOT}/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
        range: {
          start: { date: dateParts(chunk.start.toISOString().slice(0, 10)) },
          end: { date: dateParts(chunk.end.toISOString().slice(0, 10)) }
        },
        windowSizeDays: 1
      }) as { rollupDataPoints?: unknown[] };
      if (Array.isArray(data.rollupDataPoints)) appendAll(rollupDataPoints, data.rollupDataPoints);
    } catch (error) {
      errors.push(safeFailure(error));
    }
  }
  return errors.length ? { rollupDataPoints, errors } : rollupDataPoints;
}

async function exportTcx(client: OAuth2Client, exercises: unknown[]): Promise<Record<string, unknown>> {
  const tcx: Record<string, unknown> = {};
  for (const exercise of exercises) {
    const name = (exercise as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    try {
      const response = await client.request<string>({
        url: `${API_ROOT}/${name}:exportExerciseTcx`,
        params: { alt: "media", partialData: "true" },
        responseType: "text"
      });
      tcx[name] = response.data;
    } catch (error) {
      tcx[name] = safeFailure(error);
    }
  }
  return tcx;
}

export async function exportHealthData(client: OAuth2Client, options: ExportOptions): Promise<string> {
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 3660) {
    throw new Error("--days must be an integer from 1 to 3660.");
  }

  const dates = range(options.days);
  const dataTypes: Record<string, unknown> = {};
  for (const [dataType, kind, configuredMethod] of DATA_TYPES) {
    process.stdout.write(`Fetching ${dataType}...\n`);
    dataTypes[dataType] = await getDataType(client, dataType, kind, configuredMethod ?? "list", dates);
  }
  for (const dataType of DAILY_ROLLUP_TYPES) {
    process.stdout.write(`Fetching ${dataType} daily rollups...\n`);
    dataTypes[dataType] = await getDailyRollup(client, dataType, dates);
  }
  dataTypes.food = {
    skipped: true,
    reason: "The food endpoint is a very large global Fitbit food catalog, not the user's nutrition log. Personal logged food data is exported under nutrition-log."
  };

  const devices = await getPaged(client, "users/me/pairedDevices", "pairedDevices", { pageSize: 100 });
  const exerciseResult = dataTypes.exercise;
  const exercises = Array.isArray(exerciseResult)
    ? exerciseResult
    : (exerciseResult as { dataPoints?: unknown[] } | undefined)?.dataPoints;
  const exerciseTcx = options.includeTcx !== false && Array.isArray(exercises)
    ? await exportTcx(client, exercises)
    : {};

  const output = {
    metadata: {
      exportedAt: new Date().toISOString(),
      api: "Google Health API v4",
      range: { start: dates.start.toISOString(), end: dates.end.toISOString(), days: options.days }
    },
    identity: await getOptional(client, "users/me/identity"),
    profile: await getOptional(client, "users/me/profile"),
    settings: await getOptional(client, "users/me/settings"),
    irnProfile: await getOptional(client, "users/me/irnProfile"),
    pairedDevices: devices,
    dataTypes,
    exerciseTcx
  };

  const directory = resolve("data");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const compress = options.compress !== false;
  const filename = `google-health-${new Date().toISOString().replaceAll(":", "-")}.json${compress ? ".gz" : ""}`;
  const outputPath = resolve(directory, filename);
  const json = `${JSON.stringify(output)}\n`;
  const contents = compress ? await gzipAsync(json, { level: 9 }) : json;
  await writeFile(outputPath, contents, { mode: 0o600 });
  return outputPath;
}
