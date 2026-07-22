import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Client } from "pg";

type JsonObject = Record<string, unknown>;

const gunzipAsync = promisify(gunzip);

interface Aggregate {
  wearableObserved: boolean;
  steps: number;
  activeKcal: number;
  totalKcal: number;
  distanceMm: number;
  heartRateSum: number;
  heartRateCount: number;
  heartRateMin: number;
  heartRateMax: number;
  restingHeartRate?: number;
  hrvSum: number;
  hrvCount: number;
  dailyHrv?: number;
  dailyOxygenAverage?: number;
  dailyOxygenLow?: number;
  dailyOxygenHigh?: number;
  nightlySkinTemperatureC?: number;
  baselineSkinTemperatureC?: number;
  temperatureDeviationC?: number;
  respiratoryRate?: number;
  activeZoneMinutes: number;
  sleepMinutes: number;
  sleepDeepMinutes: number;
  sleepLightMinutes: number;
  sleepRemMinutes: number;
  sleepAwakeMinutes: number;
  weightSumGrams: number;
  weightCount: number;
  sleepEfficiencyPct?: number;
  sleepScore?: number;
  sleepConfidencePct?: number;
  activityScore?: number;
  activityProgressPct?: number;
  activityConfidencePct?: number;
  wearableCoveragePct?: number;
  recoveryScore?: number;
  recoveryConfidencePct?: number;
  wellnessScore?: number;
  wellnessConfidencePct?: number;
  wellnessBasedOn?: string;
  wellnessMissing?: string;
  wellnessStatus?: string;
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sleepDurationScore(hours: number): number {
  const points: Array<[number, number]> = [[4.5, 0], [6, 50], [7, 85], [7.5, 100]];
  if (hours <= points[0]![0]) return 0;
  if (hours >= points.at(-1)![0]) return 100;
  for (let index = 1; index < points.length; index += 1) {
    const [rightHours, rightScore] = points[index]!;
    const [leftHours, leftScore] = points[index - 1]!;
    if (hours <= rightHours) {
      return leftScore + (hours - leftHours) / (rightHours - leftHours) * (rightScore - leftScore);
    }
  }
  return 100;
}

interface SignalResult {
  score?: number;
  confidencePct: number;
}

function baselineSignal(
  value: number | undefined,
  history: number[],
  mode: "higher-is-better" | "lower-is-better" | "stable-is-better",
  minimumScale: number
): SignalResult {
  if (value === undefined) return { confidencePct: 0 };
  const confidencePct = Math.min(1, history.length / 30) * 100;
  if (history.length < 5) return { confidencePct };
  const center = median(history)!;
  const deviation = median(history.map((item) => Math.abs(item - center))) ?? 0;
  const scale = Math.max(deviation * 1.4826, minimumScale);
  const unfavorableDeviation = mode === "higher-is-better"
    ? Math.max(0, center - value)
    : mode === "lower-is-better"
      ? Math.max(0, value - center)
      : Math.abs(value - center);
  return { score: clamp(100 - (unfavorableDeviation / scale) * 25), confidencePct };
}

function valueHistory(history: Aggregate[], select: (item: Aggregate) => number | undefined): number[] {
  return history
    .map(select)
    .filter((value): value is number => value !== undefined)
    .slice(-30);
}

function hrvValue(aggregate: Aggregate): number | undefined {
  return aggregate.dailyHrv ?? (aggregate.hrvCount ? aggregate.hrvSum / aggregate.hrvCount : undefined);
}

function addMissingCalendarDays(days: Map<string, Aggregate>): void {
  const dates = [...days.keys()].sort();
  if (!dates.length) return;
  const cursor = new Date(`${dates[0]}T00:00:00Z`);
  const end = new Date(`${dates.at(-1)}T00:00:00Z`);
  while (cursor <= end) {
    aggregateFor(days, cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function calculateScores(days: Map<string, Aggregate>): void {
  addMissingCalendarDays(days);
  const ordered = [...days.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (let index = 0; index < ordered.length; index += 1) {
    const aggregate = ordered[index]![1];
    const sleepHours = aggregate.sleepMinutes / 60;
    if (sleepHours > 0) {
      const durationScore = sleepDurationScore(sleepHours);
      const sleepPeriodMinutes = aggregate.sleepMinutes + aggregate.sleepAwakeMinutes;
      if (sleepPeriodMinutes > 0) {
        aggregate.sleepEfficiencyPct = (aggregate.sleepMinutes / sleepPeriodMinutes) * 100;
        const efficiencyScore = clamp((aggregate.sleepEfficiencyPct - 75) / 15 * 100);
        aggregate.sleepScore = durationScore * 0.8 + efficiencyScore * 0.2;
      } else {
        aggregate.sleepScore = durationScore;
      }
    }

    const validNights = ordered
      .slice(Math.max(0, index - 13), index + 1)
      .filter(([, item]) => item.sleepScore !== undefined).length;
    aggregate.sleepConfidencePct = aggregate.sleepScore === undefined ? 0 : Math.min(1, validNights / 14) * 100;

    const activityWindow = ordered.slice(Math.max(0, index - 6), index + 1);
    const coveredDays = activityWindow.filter(([, item]) => item.wearableObserved).length;
    const activeMinutes = activityWindow.reduce((sum, [, item]) => sum + item.activeZoneMinutes, 0);
    aggregate.wearableCoveragePct = activityWindow.length ? coveredDays / activityWindow.length * 100 : 0;
    aggregate.activityConfidencePct = Math.min(1, (index + 1) / 7) * (aggregate.wearableCoveragePct / 100) * 100;
    if (coveredDays > 0) {
      const temporaryTarget = 150 * Math.min(7, index + 1) / 7;
      aggregate.activityProgressPct = activeMinutes / 150 * 100;
      aggregate.activityScore = clamp(activeMinutes / temporaryTarget * 100);
    }

    const history = ordered.slice(0, index).map(([, item]) => item);
    const recoverySignals = [
      baselineSignal(aggregate.restingHeartRate, valueHistory(history, (item) => item.restingHeartRate), "lower-is-better", 2),
      baselineSignal(hrvValue(aggregate), valueHistory(history, hrvValue), "higher-is-better", 3),
      baselineSignal(aggregate.dailyOxygenAverage, valueHistory(history, (item) => item.dailyOxygenAverage), "higher-is-better", 0.5),
      baselineSignal(aggregate.nightlySkinTemperatureC, valueHistory(history, (item) => item.nightlySkinTemperatureC), "stable-is-better", 0.15),
      baselineSignal(aggregate.respiratoryRate, valueHistory(history, (item) => item.respiratoryRate), "stable-is-better", 0.5)
    ];
    const recoveryComponents = recoverySignals
      .map((signal) => signal.score)
      .filter((value): value is number => value !== undefined);
    aggregate.recoveryConfidencePct = recoverySignals.reduce((sum, signal) => sum + signal.confidencePct, 0) / recoverySignals.length;
    if (recoveryComponents.length) {
      aggregate.recoveryScore = recoveryComponents.reduce((sum, value) => sum + value, 0) / recoveryComponents.length;
    }

    const weighted = [
      aggregate.sleepScore === undefined ? undefined : { label: "Sleep", value: aggregate.sleepScore, weight: 45 },
      aggregate.activityScore === undefined ? undefined : { label: "Activity", value: aggregate.activityScore, weight: 25 },
      aggregate.recoveryScore === undefined ? undefined : { label: "Physiological stability", value: aggregate.recoveryScore, weight: 30 }
    ].filter((value): value is { label: string; value: number; weight: number } => value !== undefined);
    const totalWeight = weighted.reduce((sum, component) => sum + component.weight, 0);
    if (totalWeight) {
      aggregate.wellnessScore = weighted.reduce((sum, component) => sum + component.value * component.weight, 0) / totalWeight;
      aggregate.wellnessConfidencePct = (
        aggregate.sleepConfidencePct * 45 +
        aggregate.activityConfidencePct * 25 +
        aggregate.recoveryConfidencePct * 30
      ) / 100;
      const availableLabels = weighted.map((component) => component.label);
      const allLabels = ["Sleep", "Activity", "Physiological stability"];
      aggregate.wellnessBasedOn = availableLabels.join(" + ");
      aggregate.wellnessMissing = allLabels.filter((label) => !availableLabels.includes(label)).join(" + ") || "None";
      aggregate.wellnessStatus = aggregate.wellnessConfidencePct < 60 ? "Provisional" : "Normal";
    }
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function child(parent: unknown, key: string): unknown {
  return object(parent)?.[key];
}

function dateFromParts(value: unknown): string | undefined {
  const date = object(value);
  const year = number(date?.year);
  const month = number(date?.month);
  const day = number(date?.day);
  if (!year || !month || !day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function intervalDay(payload: unknown): string | undefined {
  const interval = child(payload, "interval");
  return dateFromParts(child(child(child(interval, "civilStartTime"), "date"), "date"))
    ?? dateFromParts(child(child(interval, "civilStartTime"), "date"))
    ?? isoDay(child(interval, "startTime"));
}

function sampleDay(payload: unknown): string | undefined {
  const sampleTime = child(payload, "sampleTime");
  return dateFromParts(child(child(sampleTime, "civilTime"), "date"))
    ?? isoDay(child(sampleTime, "physicalTime"));
}

function directDay(payload: unknown): string | undefined {
  return dateFromParts(child(payload, "date"));
}

function isoDay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

function aggregateFor(days: Map<string, Aggregate>, day: string): Aggregate {
  let value = days.get(day);
  if (!value) {
    value = {
      wearableObserved: false,
      steps: 0, activeKcal: 0, totalKcal: 0, distanceMm: 0,
      heartRateSum: 0, heartRateCount: 0, heartRateMin: Infinity, heartRateMax: -Infinity,
      hrvSum: 0, hrvCount: 0,
      activeZoneMinutes: 0, sleepMinutes: 0, sleepDeepMinutes: 0,
      sleepLightMinutes: 0, sleepRemMinutes: 0, sleepAwakeMinutes: 0,
      weightSumGrams: 0, weightCount: 0
    };
    days.set(day, value);
  }
  return value;
}

function records(dataTypes: JsonObject, category: string): unknown[] {
  const value = dataTypes[category];
  if (Array.isArray(value)) return value;
  return array(child(value, "rollupDataPoints"));
}

function payload(record: unknown, key: string): unknown {
  return child(record, key);
}

function addIntervalMetric(
  days: Map<string, Aggregate>, dataTypes: JsonObject, category: string, payloadKey: string,
  valueKey: string, apply: (aggregate: Aggregate, value: number) => void
): void {
  for (const record of records(dataTypes, category)) {
    const valuePayload = payload(record, payloadKey);
    const day = intervalDay(valuePayload);
    const value = number(child(valuePayload, valueKey));
    if (day && value !== undefined) apply(aggregateFor(days, day), value);
  }
}

function addSampleMetric(
  days: Map<string, Aggregate>, dataTypes: JsonObject, category: string, payloadKey: string,
  valueKey: string, apply: (aggregate: Aggregate, value: number) => void
): void {
  for (const record of records(dataTypes, category)) {
    const valuePayload = payload(record, payloadKey);
    const day = sampleDay(valuePayload);
    const value = number(child(valuePayload, valueKey));
    if (day && value !== undefined) apply(aggregateFor(days, day), value);
  }
}

async function latestExport(): Promise<string> {
  const directory = resolve("data");
  const candidates = (await readdir(directory))
    .filter((name) => /^google-health-.*\.json(?:\.gz)?$/.test(name))
    .map((name) => resolve(directory, name));
  if (!candidates.length) throw new Error("No Google Health JSON export found in data/.");
  const withTimes = await Promise.all(candidates.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs })));
  withTimes.sort((a, b) => b.modified - a.modified);
  return withTimes[0]!.path;
}

async function buildDailyRows(filePath: string): Promise<Map<string, Aggregate>> {
  process.stdout.write(`Loading ${filePath}...\n`);
  const file = await readFile(filePath);
  const json = filePath.endsWith(".gz") ? (await gunzipAsync(file)).toString("utf8") : file.toString("utf8");
  const parsed = JSON.parse(json) as JsonObject;
  const dataTypes = object(parsed.dataTypes) ?? {};
  const days = new Map<string, Aggregate>();

  addIntervalMetric(days, dataTypes, "steps", "steps", "count", (a, v) => { a.steps += v; a.wearableObserved = true; });
  addIntervalMetric(days, dataTypes, "active-energy-burned", "activeEnergyBurned", "kcal", (a, v) => { a.activeKcal += v; a.wearableObserved = true; });
  addIntervalMetric(days, dataTypes, "distance", "distance", "millimeters", (a, v) => { a.distanceMm += v; a.wearableObserved = true; });
  addSampleMetric(days, dataTypes, "heart-rate", "heartRate", "beatsPerMinute", (a, v) => {
    a.wearableObserved = true;
    a.heartRateSum += v;
    a.heartRateCount += 1;
    a.heartRateMin = Math.min(a.heartRateMin, v);
    a.heartRateMax = Math.max(a.heartRateMax, v);
  });
  addSampleMetric(days, dataTypes, "heart-rate-variability", "heartRateVariability", "rootMeanSquareOfSuccessiveDifferencesMilliseconds", (a, v) => {
    a.hrvSum += v;
    a.hrvCount += 1;
  });
  // Intraday SpO2 includes transient/low-quality readings. Prefer Google's
  // sleep-derived daily summary for health-level visualization.
  for (const record of records(dataTypes, "daily-oxygen-saturation")) {
    const valuePayload = payload(record, "dailyOxygenSaturation");
    const day = directDay(valuePayload);
    if (!day) continue;
    const aggregate = aggregateFor(days, day);
    aggregate.dailyOxygenAverage = number(child(valuePayload, "averagePercentage"));
    aggregate.dailyOxygenLow = number(child(valuePayload, "lowerBoundPercentage"));
    aggregate.dailyOxygenHigh = number(child(valuePayload, "upperBoundPercentage"));
  }
  for (const record of records(dataTypes, "daily-sleep-temperature-derivations")) {
    const valuePayload = payload(record, "dailySleepTemperatureDerivations");
    const day = directDay(valuePayload);
    if (!day) continue;
    const aggregate = aggregateFor(days, day);
    aggregate.nightlySkinTemperatureC = number(child(valuePayload, "nightlyTemperatureCelsius"));
    aggregate.baselineSkinTemperatureC = number(child(valuePayload, "baselineTemperatureCelsius"));
    if (aggregate.nightlySkinTemperatureC !== undefined && aggregate.baselineSkinTemperatureC !== undefined) {
      aggregate.temperatureDeviationC = aggregate.nightlySkinTemperatureC - aggregate.baselineSkinTemperatureC;
    }
  }
  for (const record of records(dataTypes, "daily-respiratory-rate")) {
    const valuePayload = payload(record, "dailyRespiratoryRate");
    const day = directDay(valuePayload);
    const value = number(child(valuePayload, "breathsPerMinute"));
    if (day && value !== undefined) aggregateFor(days, day).respiratoryRate = value;
  }
  addIntervalMetric(days, dataTypes, "active-zone-minutes", "activeZoneMinutes", "activeZoneMinutes", (a, v) => {
    a.activeZoneMinutes += v;
    a.wearableObserved = true;
  });
  addSampleMetric(days, dataTypes, "weight", "weight", "weightGrams", (a, v) => {
    a.weightSumGrams += v;
    a.weightCount += 1;
  });

  for (const record of records(dataTypes, "daily-resting-heart-rate")) {
    const valuePayload = payload(record, "dailyRestingHeartRate");
    const day = directDay(valuePayload);
    const value = number(child(valuePayload, "beatsPerMinute"));
    if (day && value !== undefined) {
      const aggregate = aggregateFor(days, day);
      aggregate.restingHeartRate = value;
      aggregate.wearableObserved = true;
    }
  }
  for (const record of records(dataTypes, "daily-heart-rate-variability")) {
    const valuePayload = payload(record, "dailyHeartRateVariability");
    const day = directDay(valuePayload);
    const value = number(child(valuePayload, "averageHeartRateVariabilityMilliseconds"));
    if (day && value !== undefined) aggregateFor(days, day).dailyHrv = value;
  }
  for (const record of records(dataTypes, "sleep")) {
    const valuePayload = payload(record, "sleep");
    const interval = child(valuePayload, "interval");
    const day = isoDay(child(interval, "endTime"));
    const minutes = number(child(child(valuePayload, "summary"), "minutesAsleep"));
    if (!day) continue;
    const aggregate = aggregateFor(days, day);
    if (minutes !== undefined) aggregate.sleepMinutes += minutes;
    for (const stage of array(child(child(valuePayload, "summary"), "stagesSummary"))) {
      const type = child(stage, "type");
      const stageMinutes = number(child(stage, "minutes"));
      if (stageMinutes === undefined) continue;
      if (type === "DEEP") aggregate.sleepDeepMinutes += stageMinutes;
      else if (type === "LIGHT" || type === "ASLEEP") aggregate.sleepLightMinutes += stageMinutes;
      else if (type === "REM") aggregate.sleepRemMinutes += stageMinutes;
      else if (type === "AWAKE") aggregate.sleepAwakeMinutes += stageMinutes;
    }
  }
  for (const record of records(dataTypes, "total-calories")) {
    const day = dateFromParts(child(child(record, "civilStartTime"), "date"));
    const value = number(child(child(record, "totalCalories"), "kcalSum"));
    if (day && value !== undefined) aggregateFor(days, day).totalKcal += value;
  }

  calculateScores(days);

  return days;
}

async function importRows(filePath: string, days: Map<string, Aggregate>): Promise<void> {
  const client = new Client({
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? "gohealth",
    user: process.env.POSTGRES_USER ?? "gohealth",
    password: process.env.POSTGRES_PASSWORD ?? "gohealth_local"
  });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS health_daily (
        day date PRIMARY KEY,
        steps bigint,
        active_kcal double precision,
        total_kcal double precision,
        distance_km double precision,
        heart_rate_avg double precision,
        heart_rate_min double precision,
        heart_rate_max double precision,
        resting_heart_rate double precision,
        hrv_ms double precision,
        oxygen_saturation_avg double precision,
        oxygen_saturation_low double precision,
        oxygen_saturation_high double precision,
        nightly_skin_temperature_c double precision,
        baseline_skin_temperature_c double precision,
        temperature_deviation_c double precision,
        respiratory_rate double precision,
        active_zone_minutes double precision,
        sleep_hours double precision,
        sleep_deep_hours double precision,
        sleep_light_hours double precision,
        sleep_rem_hours double precision,
        sleep_awake_hours double precision,
        sleep_efficiency_pct double precision,
        sleep_score double precision,
        sleep_confidence_pct double precision,
        activity_score double precision,
        activity_progress_pct double precision,
        activity_confidence_pct double precision,
        wearable_coverage_pct double precision,
        recovery_score double precision,
        recovery_confidence_pct double precision,
        wellness_score double precision,
        wellness_confidence_pct double precision,
        wellness_based_on text,
        wellness_missing text,
        wellness_status text,
        weight_kg double precision,
        source_file text NOT NULL,
        imported_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS oxygen_saturation_low double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS oxygen_saturation_high double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS nightly_skin_temperature_c double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS baseline_skin_temperature_c double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS temperature_deviation_c double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS respiratory_rate double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS active_zone_minutes double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS sleep_deep_hours double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS sleep_light_hours double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS sleep_rem_hours double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS sleep_awake_hours double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS sleep_efficiency_pct double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS sleep_score double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS sleep_confidence_pct double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS activity_score double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS activity_progress_pct double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS activity_confidence_pct double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS wearable_coverage_pct double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS recovery_score double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS recovery_confidence_pct double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS wellness_score double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS wellness_confidence_pct double precision");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS wellness_based_on text");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS wellness_missing text");
    await client.query("ALTER TABLE health_daily ADD COLUMN IF NOT EXISTS wellness_status text");
    await client.query("BEGIN");
    for (const [day, a] of [...days.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const values = [
        day, a.wearableObserved ? a.steps : null, a.wearableObserved ? a.activeKcal : null,
        a.totalKcal || null, a.wearableObserved ? a.distanceMm / 1_000_000 : null,
        a.heartRateCount ? a.heartRateSum / a.heartRateCount : null,
        a.heartRateCount ? a.heartRateMin : null, a.heartRateCount ? a.heartRateMax : null,
        a.restingHeartRate ?? null, a.dailyHrv ?? (a.hrvCount ? a.hrvSum / a.hrvCount : null),
        a.dailyOxygenAverage ?? null, a.dailyOxygenLow ?? null, a.dailyOxygenHigh ?? null,
        a.nightlySkinTemperatureC ?? null, a.baselineSkinTemperatureC ?? null,
        a.temperatureDeviationC ?? null, a.respiratoryRate ?? null,
        a.wearableObserved ? a.activeZoneMinutes : null,
        a.sleepMinutes ? a.sleepMinutes / 60 : null,
        a.sleepDeepMinutes ? a.sleepDeepMinutes / 60 : null,
        a.sleepLightMinutes ? a.sleepLightMinutes / 60 : null,
        a.sleepRemMinutes ? a.sleepRemMinutes / 60 : null,
        a.sleepAwakeMinutes ? a.sleepAwakeMinutes / 60 : null,
        a.sleepEfficiencyPct ?? null, a.sleepScore ?? null, a.sleepConfidencePct ?? null,
        a.activityScore ?? null, a.activityProgressPct ?? null, a.activityConfidencePct ?? null,
        a.wearableCoveragePct ?? null, a.recoveryScore ?? null, a.recoveryConfidencePct ?? null,
        a.wellnessScore ?? null, a.wellnessConfidencePct ?? null,
        a.wellnessBasedOn ?? null, a.wellnessMissing ?? null, a.wellnessStatus ?? null,
        a.weightCount ? a.weightSumGrams / a.weightCount / 1000 : null, filePath
      ];
      await client.query(`
        INSERT INTO health_daily (
          day, steps, active_kcal, total_kcal, distance_km, heart_rate_avg, heart_rate_min,
          heart_rate_max, resting_heart_rate, hrv_ms, oxygen_saturation_avg,
          oxygen_saturation_low, oxygen_saturation_high, nightly_skin_temperature_c,
          baseline_skin_temperature_c, temperature_deviation_c, respiratory_rate,
          active_zone_minutes, sleep_hours, sleep_deep_hours, sleep_light_hours,
          sleep_rem_hours, sleep_awake_hours, sleep_efficiency_pct, sleep_score, sleep_confidence_pct,
          activity_score, activity_progress_pct, activity_confidence_pct, wearable_coverage_pct,
          recovery_score, recovery_confidence_pct, wellness_score, wellness_confidence_pct,
          wellness_based_on, wellness_missing, wellness_status,
          weight_kg, source_file
        ) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
        ON CONFLICT (day) DO UPDATE SET
          steps=EXCLUDED.steps, active_kcal=EXCLUDED.active_kcal, total_kcal=EXCLUDED.total_kcal,
          distance_km=EXCLUDED.distance_km, heart_rate_avg=EXCLUDED.heart_rate_avg,
          heart_rate_min=EXCLUDED.heart_rate_min, heart_rate_max=EXCLUDED.heart_rate_max,
          resting_heart_rate=EXCLUDED.resting_heart_rate, hrv_ms=EXCLUDED.hrv_ms,
          oxygen_saturation_avg=EXCLUDED.oxygen_saturation_avg,
          oxygen_saturation_low=EXCLUDED.oxygen_saturation_low,
          oxygen_saturation_high=EXCLUDED.oxygen_saturation_high,
          nightly_skin_temperature_c=EXCLUDED.nightly_skin_temperature_c,
          baseline_skin_temperature_c=EXCLUDED.baseline_skin_temperature_c,
          temperature_deviation_c=EXCLUDED.temperature_deviation_c,
          respiratory_rate=EXCLUDED.respiratory_rate,
          active_zone_minutes=EXCLUDED.active_zone_minutes,
          sleep_hours=EXCLUDED.sleep_hours, sleep_deep_hours=EXCLUDED.sleep_deep_hours,
          sleep_light_hours=EXCLUDED.sleep_light_hours, sleep_rem_hours=EXCLUDED.sleep_rem_hours,
          sleep_awake_hours=EXCLUDED.sleep_awake_hours,
          sleep_efficiency_pct=EXCLUDED.sleep_efficiency_pct, sleep_score=EXCLUDED.sleep_score,
          sleep_confidence_pct=EXCLUDED.sleep_confidence_pct,
          activity_score=EXCLUDED.activity_score, activity_progress_pct=EXCLUDED.activity_progress_pct,
          activity_confidence_pct=EXCLUDED.activity_confidence_pct,
          wearable_coverage_pct=EXCLUDED.wearable_coverage_pct,
          recovery_score=EXCLUDED.recovery_score, recovery_confidence_pct=EXCLUDED.recovery_confidence_pct,
          wellness_score=EXCLUDED.wellness_score, wellness_based_on=EXCLUDED.wellness_based_on,
          wellness_missing=EXCLUDED.wellness_missing, wellness_status=EXCLUDED.wellness_status,
          wellness_confidence_pct=EXCLUDED.wellness_confidence_pct,
          weight_kg=EXCLUDED.weight_kg, source_file=EXCLUDED.source_file, imported_at=now()
      `, values);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const filePath = process.argv[2] ? resolve(process.argv[2]) : await latestExport();
  const days = await buildDailyRows(filePath);
  await importRows(filePath, days);
  process.stdout.write(`Imported ${days.size} daily rows into PostgreSQL.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Dashboard import failed."}\n`);
  process.exitCode = 1;
});
