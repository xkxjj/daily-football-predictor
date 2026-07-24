import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dashboardPath = resolve("data", "predictions.json");
const dashboard = JSON.parse(await readFile(dashboardPath, "utf8"));
const generatedAt = new Date(dashboard.generatedAt);
const maxAgeMinutes = Number(process.env.MAX_DATA_AGE_MINUTES || 240);

if (!Number.isFinite(generatedAt.getTime())) {
  throw new Error("data/predictions.json is missing a valid generatedAt timestamp");
}

if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
  throw new Error("MAX_DATA_AGE_MINUTES must be a positive number");
}

const ageMinutes = (Date.now() - generatedAt.getTime()) / 60_000;
console.log(`Prediction data age: ${ageMinutes.toFixed(1)} minutes (limit: ${maxAgeMinutes})`);

if (ageMinutes > maxAgeMinutes) {
  throw new Error(
    `Prediction data is stale: generatedAt=${dashboard.generatedAt}, age=${ageMinutes.toFixed(1)} minutes`
  );
}

console.log(`Prediction data is fresh for window ${dashboard.window?.start}—${dashboard.window?.end}.`);
