#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 365;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseDay(value, field = "date") {
  assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), `${field} must be YYYY-MM-DD`);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  assert(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, `${field} is not a calendar date: ${value}`);
  return time;
}

export function addDays(day, amount) {
  return new Date(parseDay(day) + amount * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(start, end) {
  const startTime = parseDay(start, "start");
  const endTime = parseDay(end, "end");
  assert(startTime <= endTime, `start ${start} is after end ${end}`);
  return Math.round((endTime - startTime) / DAY_MS) + 1;
}

export function enumerateDays(start, end) {
  const count = daysBetween(start, end);
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

export function splitDateRange(start, end, maxDays = MAX_RANGE_DAYS) {
  assert(Number.isInteger(maxDays) && maxDays > 0, "maxDays must be a positive integer");
  const chunks = [];
  let cursor = start;
  while (parseDay(cursor) <= parseDay(end)) {
    const chunkEnd = addDays(cursor, Math.min(maxDays, daysBetween(cursor, end)) - 1);
    chunks.push({ start: cursor, end: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

export function normalizeRangePayload(payload, expected) {
  assert(payload && typeof payload === "object", "range response must be an object");
  assert(payload.package === expected.packageName, `range package mismatch for ${expected.packageName}`);
  assert(payload.start === expected.start && payload.end === expected.end, `range bounds mismatch for ${expected.packageName}`);
  assert(Array.isArray(payload.downloads), `range downloads must be an array for ${expected.packageName}`);
  const byDay = new Map();
  for (const item of payload.downloads) {
    assert(item && typeof item === "object", `range item must be an object for ${expected.packageName}`);
    parseDay(item.day, "range day");
    assert(parseDay(item.day) >= parseDay(expected.start) && parseDay(item.day) <= parseDay(expected.end), `range day outside requested bounds: ${item.day}`);
    assert(Number.isSafeInteger(item.downloads) && item.downloads >= 0, `invalid download count for ${expected.packageName} on ${item.day}`);
    assert(!byDay.has(item.day), `duplicate range day for ${expected.packageName}: ${item.day}`);
    byDay.set(item.day, item.downloads);
  }
  return enumerateDays(expected.start, expected.end).map((day) => ({ day, downloads: byDay.get(day) ?? 0 }));
}

export function reconcilePointPayload(payload, expected, daily) {
  assert(payload && typeof payload === "object", "point response must be an object");
  assert(payload.package === expected.packageName, `point package mismatch for ${expected.packageName}`);
  assert(payload.start === expected.start && payload.end === expected.end, `point bounds mismatch for ${expected.packageName}`);
  assert(Number.isSafeInteger(payload.downloads) && payload.downloads >= 0, `invalid point total for ${expected.packageName}`);
  const rangeTotal = daily.reduce((sum, item) => sum + item.downloads, 0);
  assert(rangeTotal === payload.downloads, `range/point mismatch for ${expected.packageName} ${expected.start}:${expected.end}: ${rangeTotal} !== ${payload.downloads}`);
  return rangeTotal;
}

async function fetchJson(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(`npm API request failed for ${url}: ${error.message}`, { cause: error });
  }
  assert(response && response.ok, `npm API returned HTTP ${response?.status ?? "unknown"} for ${url}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`npm API returned invalid JSON for ${url}`, { cause: error });
  }
}

export async function collectPackageSeries(spec, end, fetchImpl = fetch) {
  assert(spec && typeof spec === "object", "package spec must be an object");
  assert(typeof spec.package === "string" && spec.package.length > 0, "package name is required");
  assert(typeof spec.label === "string" && spec.label.length > 0, `label is required for ${spec.package}`);
  assert(/^#[0-9a-fA-F]{6}$/.test(spec.color), `color must be a six-digit hex value for ${spec.package}`);
  parseDay(spec.start, `start for ${spec.package}`);
  parseDay(end, "end");
  assert(parseDay(spec.start) <= parseDay(end), `package start is after data end for ${spec.package}`);

  const downloads = [];
  const sources = [];
  for (const chunk of splitDateRange(spec.start, end)) {
    const encodedPackage = encodeURIComponent(spec.package);
    const period = `${chunk.start}:${chunk.end}`;
    const rangeUrl = `https://api.npmjs.org/downloads/range/${period}/${encodedPackage}`;
    const pointUrl = `https://api.npmjs.org/downloads/point/${period}/${encodedPackage}`;
    const [rangePayload, pointPayload] = await Promise.all([
      fetchJson(rangeUrl, fetchImpl),
      fetchJson(pointUrl, fetchImpl),
    ]);
    const expected = { packageName: spec.package, start: chunk.start, end: chunk.end };
    const normalized = normalizeRangePayload(rangePayload, expected);
    reconcilePointPayload(pointPayload, expected, normalized);
    downloads.push(...normalized);
    sources.push({ package: spec.package, start: chunk.start, end: chunk.end, range: rangeUrl, point: pointUrl });
  }
  return { spec, downloads, sources };
}

export function buildStatsDocument(config, collected, generatedAt, end) {
  assert(config?.schema === 1, "config schema must be 1");
  assert(typeof config.title === "string" && config.title.length > 0, "config title is required");
  assert(Array.isArray(config.packages) && config.packages.length > 0, "config packages must be a non-empty array");
  assert(typeof generatedAt === "string" && Number.isFinite(Date.parse(generatedAt)), "generatedAt must be an ISO timestamp");
  parseDay(end, "data end");
  const expectedPackages = config.packages.map((item) => item.package);
  assert(new Set(expectedPackages).size === expectedPackages.length, "config package names must be unique");
  const collectedByPackage = new Map(collected.map((item) => [item.spec.package, item]));
  assert(collectedByPackage.size === expectedPackages.length, "collected package set does not match config");

  const series = config.packages.map((spec) => {
    const source = collectedByPackage.get(spec.package);
    assert(source, `missing collected data for ${spec.package}`);
    let cumulative = 0;
    const downloads = source.downloads.map((item) => {
      cumulative += item.downloads;
      return { day: item.day, downloads: item.downloads, cumulative };
    });
    return { package: spec.package, label: spec.label, color: spec.color, start: spec.start, total: cumulative, downloads };
  });
  const start = config.packages.map((item) => item.start).sort()[0];
  const projectCumulative = [];
  let projectTotal = 0;
  for (const day of enumerateDays(start, end)) {
    const daily = series.reduce((sum, item) => sum + (item.downloads.find((entry) => entry.day === day)?.downloads ?? 0), 0);
    projectTotal += daily;
    projectCumulative.push({ day, downloads: daily, cumulative: projectTotal });
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    data_through: end,
    period: { start, end },
    title: config.title,
    rename: config.rename ?? null,
    packages: series,
    project_cumulative: projectCumulative,
    sources: collected.flatMap((item) => item.sources),
    note: "npm downloads are requests, not unique installs or users",
  };
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function linePoints(values, xForIndex, yForValue) {
  return values.map((value, index) => `${xForIndex(index).toFixed(2)},${yForValue(value).toFixed(2)}`).join(" ");
}

function tickIndexes(length) {
  const indexes = new Set([0, Math.max(0, length - 1)]);
  for (let step = 1; step < 4; step += 1) indexes.add(Math.round(((length - 1) * step) / 4));
  return [...indexes].sort((a, b) => a - b);
}

export function renderSvg(document) {
  const width = 960;
  const height = 640;
  const left = 78;
  const right = 28;
  const plotWidth = width - left - right;
  const topY = 104;
  const panelHeight = 190;
  const lowerY = 370;
  const allDays = enumerateDays(document.period.start, document.period.end);
  const dayIndex = new Map(allDays.map((day, index) => [day, index]));
  const x = (index) => left + (allDays.length === 1 ? plotWidth / 2 : (index / (allDays.length - 1)) * plotWidth);
  const dailyMax = Math.max(1, ...document.packages.flatMap((item) => item.downloads.map((entry) => entry.downloads)));
  const cumulativeMax = Math.max(1, ...document.project_cumulative.map((entry) => entry.cumulative));
  const yDaily = (value) => topY + panelHeight - (value / dailyMax) * panelHeight;
  const yCumulative = (value) => lowerY + panelHeight - (value / cumulativeMax) * panelHeight;
  const grid = (originY, max) => Array.from({ length: 5 }, (_, index) => {
    const value = Math.round((max * index) / 4);
    const y = originY + panelHeight - (panelHeight * index) / 4;
    return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="grid"/><text x="${left - 12}" y="${y + 4}" text-anchor="end" class="axis">${value}</text>`;
  }).join("");
  const dailyLines = document.packages.map((item) => {
    const values = allDays.map((day) => item.downloads.find((entry) => entry.day === day)?.downloads ?? 0);
    return `<polyline points="${linePoints(values, x, yDaily)}" fill="none" stroke="${xml(item.color)}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join("");
  const cumulativeValues = document.project_cumulative.map((entry) => entry.cumulative);
  const ticks = tickIndexes(allDays.length);
  const xTicks = ticks.map((index, tickPosition) => {
    const isFirst = tickPosition === 0;
    const isLast = tickPosition === ticks.length - 1;
    const anchor = isFirst ? "start" : "middle";
    const tickX = isLast ? Math.min(x(index), width - right - 46) : x(index);
    return `<text x="${tickX}" y="${lowerY + panelHeight + 28}" text-anchor="${anchor}" class="axis">${xml(allDays[index])}</text>`;
  }).join("");
  const legend = document.packages.map((item, index) => `<g transform="translate(${left + index * 260},72)"><line x1="0" y1="0" x2="24" y2="0" stroke="${xml(item.color)}" stroke-width="3"/><text x="32" y="4" class="legend">${xml(item.label)} (${item.total})</text></g>`).join("");
  let renameMarker = "";
  if (document.rename) {
    const index = dayIndex.get(document.rename.date);
    assert(index !== undefined, `rename date is outside chart period: ${document.rename.date}`);
    const markerX = Math.min(width - right - 1, x(index));
    const markerLabel = `${document.rename.label} · ${document.rename.date}`;
    const labelX = left + 8;
    renameMarker = `<line x1="${markerX}" y1="${topY}" x2="${markerX}" y2="${lowerY + panelHeight}" class="rename"/><text x="${labelX}" y="${topY + 14}" text-anchor="start" class="rename-label">${xml(markerLabel)}</text>`;
  }
  const description = `${document.title}. Daily npm downloads by package above and combined cumulative downloads below. Data through ${document.data_through}. npm downloads are requests, not unique installs or users.`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-desc">
  <title id="chart-title">${xml(document.title)}</title>
  <desc id="chart-desc">${xml(description)}</desc>
  <style>
    text { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #172033; }
    .title { font-size: 22px; font-weight: 700; } .subtitle { font-size: 12px; fill: #596579; }
    .panel { font-size: 14px; font-weight: 650; } .axis { font-size: 11px; fill: #657086; }
    .legend { font-size: 12px; } .grid { stroke: #dce2ea; stroke-width: 1; }
    .rename { stroke: #8b5cf6; stroke-width: 1.5; stroke-dasharray: 5 4; } .rename-label { font-size: 11px; fill: #6d28d9; }
  </style>
  <rect width="100%" height="100%" rx="14" fill="#ffffff"/>
  <text x="${left}" y="34" class="title">${xml(document.title)}</text>
  <text x="${left}" y="54" class="subtitle">Data through ${xml(document.data_through)} · Source: npm Downloads API · downloads are not unique installs</text>
  ${legend}
  <text x="${left}" y="${topY - 14}" class="panel">Daily npm downloads</text>
  ${grid(topY, dailyMax)}
  ${dailyLines}
  <text x="${left}" y="${lowerY - 14}" class="panel">Combined cumulative npm downloads</text>
  ${grid(lowerY, cumulativeMax)}
  <polyline points="${linePoints(cumulativeValues, x, yCumulative)}" fill="none" stroke="#0f766e" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  ${renameMarker}
  ${xTicks}
  <text x="${left}" y="618" class="subtitle">Generated ${xml(document.generated_at)} · npm download counts measure registry requests, not people or successful installations.</text>
</svg>
`;
}

function yesterdayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS).toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const result = { end: yesterdayUtc(), generatedAt: new Date().toISOString() };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(["--config", "--output-dir", "--end-date", "--generated-at"].includes(key), `unknown argument: ${key}`);
    assert(value, `missing value for ${key}`);
    if (key === "--config") result.config = value;
    if (key === "--output-dir") result.outputDir = value;
    if (key === "--end-date") result.end = value;
    if (key === "--generated-at") result.generatedAt = value;
    index += 1;
  }
  assert(result.config, "--config is required");
  assert(result.outputDir, "--output-dir is required");
  return result;
}

async function writeAtomic(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

export async function run(argv, fetchImpl = fetch) {
  const args = parseArgs(argv);
  parseDay(args.end, "end date");
  const config = JSON.parse(await readFile(args.config, "utf8"));
  const collected = await Promise.all(config.packages.map((spec) => collectPackageSeries(spec, args.end, fetchImpl)));
  const document = buildStatsDocument(config, collected, args.generatedAt, args.end);
  const svg = renderSvg(document);
  assert(!svg.includes("NaN"), "generated SVG contains NaN");
  await mkdir(args.outputDir, { recursive: true });
  await writeAtomic(path.join(args.outputDir, "npm-downloads.json"), `${JSON.stringify(document, null, 2)}\n`);
  await writeAtomic(path.join(args.outputDir, "npm-downloads.svg"), svg);
  return document;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2)).then((document) => {
    console.log(`Wrote npm download statistics through ${document.data_through}.`);
  }).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
