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
    project: config.project ?? config.title,
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

function niceCeiling(value) {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = magnitude >= 10 ? magnitude / 2 : 1;
  return Math.ceil(value / step) * step;
}

function formatCount(value, locale) {
  return new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US").format(value);
}

const COPY = {
  en: {
    title: (project) => `${project} npm download growth`,
    subtitle: "Cumulative registry downloads over time",
    total: "Total downloads",
    axis: "Cumulative downloads",
    through: "Data through",
    source: "Source: npm Downloads API",
    note: "Download counts measure registry requests, not unique users or confirmed installations.",
    previous: "Previous package",
    current: "Current package",
    package: "Package",
    renamed: "Renamed",
  },
  "zh-CN": {
    title: (project) => `${project} npm 下载增长`,
    subtitle: "累计 registry 下载请求随时间的变化",
    total: "累计下载量",
    axis: "累计下载量",
    through: "数据截至",
    source: "来源：npm Downloads API",
    note: "下载量统计 registry 请求，不等于独立用户数或已确认的真实安装人数。",
    previous: "旧包",
    current: "当前包",
    package: "npm 包",
    renamed: "更名",
  },
};

export function renderSvg(document, locale = "en") {
  assert(Object.hasOwn(COPY, locale), `unsupported locale: ${locale}`);
  const copy = COPY[locale];
  const width = 960;
  const height = 540;
  const left = 84;
  const right = 36;
  const plotWidth = width - left - right;
  const plotTop = 176;
  const plotBottom = 436;
  const plotHeight = plotBottom - plotTop;
  const allDays = enumerateDays(document.period.start, document.period.end);
  const dayIndex = new Map(allDays.map((day, index) => [day, index]));
  const x = (index) => left + (allDays.length === 1 ? plotWidth / 2 : (index / (allDays.length - 1)) * plotWidth);
  const projectTotal = document.project_cumulative.at(-1)?.cumulative ?? 0;
  const cumulativeMax = niceCeiling(Math.max(1, projectTotal));
  const yCumulative = (value) => plotBottom - (value / cumulativeMax) * plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = Math.round((cumulativeMax * index) / 4);
    const y = plotBottom - (plotHeight * index) / 4;
    return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="grid"/><text x="${left - 14}" y="${y + 4}" text-anchor="end" class="axis">${xml(formatCount(value, locale))}</text>`;
  }).join("");
  const cumulativeValues = document.project_cumulative.map((entry) => entry.cumulative);
  const cumulativePoints = linePoints(cumulativeValues, x, yCumulative);
  const areaPoints = `${x(0).toFixed(2)},${plotBottom} ${cumulativePoints} ${x(allDays.length - 1).toFixed(2)},${plotBottom}`;
  const ticks = tickIndexes(allDays.length);
  const xTicks = ticks.map((index, tickPosition) => {
    const isFirst = tickPosition === 0;
    const isLast = tickPosition === ticks.length - 1;
    const anchor = isFirst ? "start" : isLast ? "end" : "middle";
    return `<text x="${x(index)}" y="${plotBottom + 28}" text-anchor="${anchor}" class="axis">${xml(allDays[index])}</text>`;
  }).join("");
  const packageSummary = document.packages.map((item, index) => {
    const role = document.packages.length === 1 ? copy.package : index === 0 ? copy.previous : copy.current;
    const summaryX = left + index * 272;
    return `<g transform="translate(${summaryX},102)"><circle cx="5" cy="-4" r="5" fill="${xml(item.color)}"/><text x="18" y="0" class="package-role">${xml(role)}</text><text x="18" y="23" class="package-name">${xml(item.package)}</text><text x="244" y="23" text-anchor="end" class="package-total">${xml(formatCount(item.total, locale))}</text></g>`;
  }).join("");
  let renameMarker = "";
  if (document.rename) {
    const index = dayIndex.get(document.rename.date);
    assert(index !== undefined, `rename date is outside chart period: ${document.rename.date}`);
    const markerX = x(index);
    const markerAnchor = markerX > width - right - 180 ? "end" : "start";
    const markerLabelX = markerAnchor === "end" ? markerX - 10 : markerX + 10;
    renameMarker = `<line x1="${markerX}" y1="${plotTop}" x2="${markerX}" y2="${plotBottom}" class="rename"/><text x="${markerLabelX}" y="${plotTop + 18}" text-anchor="${markerAnchor}" class="rename-label">${xml(copy.renamed)} · ${xml(document.rename.date)}</text>`;
  }
  const project = document.project ?? document.title;
  const title = copy.title(project);
  const description = `${title}. ${copy.subtitle}. ${copy.through} ${document.data_through}. ${copy.note}`;
  const endX = x(allDays.length - 1);
  const endY = yCumulative(projectTotal);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-desc">
  <title id="chart-title">${xml(title)}</title>
  <desc id="chart-desc">${xml(description)}</desc>
  <defs>
    <linearGradient id="growth-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#14b8a6" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="#14b8a6" stop-opacity="0.02"/>
    </linearGradient>
    <filter id="soft-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#0f172a" flood-opacity="0.08"/>
    </filter>
  </defs>
  <style>
    text { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; fill: #172033; }
    .title { font-size: 24px; font-weight: 720; letter-spacing: -0.3px; }
    .subtitle { font-size: 12px; fill: #64748b; }
    .metric-label { font-size: 11px; fill: #64748b; font-weight: 650; letter-spacing: 0.4px; }
    .metric-value { font-size: 34px; fill: #0f766e; font-weight: 760; letter-spacing: -1px; }
    .axis-title { font-size: 12px; fill: #475569; font-weight: 650; }
    .axis { font-size: 11px; fill: #718096; }
    .grid { stroke: #e6edf4; stroke-width: 1; }
    .package-role { font-size: 11px; fill: #64748b; font-weight: 650; }
    .package-name { font-size: 12px; fill: #334155; }
    .package-total { font-size: 13px; fill: #172033; font-weight: 720; }
    .rename { stroke: #8b5cf6; stroke-width: 1.5; stroke-dasharray: 5 5; }
    .rename-label { font-size: 11px; fill: #6d28d9; font-weight: 650; }
    .endpoint { font-size: 12px; fill: #0f766e; font-weight: 740; }
  </style>
  <rect width="100%" height="100%" rx="18" fill="#f8fafc"/>
  <rect x="18" y="18" width="924" height="504" rx="16" fill="#ffffff" filter="url(#soft-shadow)"/>
  <text x="${left}" y="50" class="title">${xml(title)}</text>
  <text x="${left}" y="72" class="subtitle">${xml(copy.subtitle)} · ${xml(copy.through)} ${xml(document.data_through)}</text>
  <text x="${width - right}" y="38" text-anchor="end" class="metric-label">${xml(copy.total)}</text>
  <text x="${width - right}" y="70" text-anchor="end" class="metric-value">${xml(formatCount(projectTotal, locale))}</text>
  ${packageSummary}
  <text x="${left}" y="${plotTop - 16}" class="axis-title">${xml(copy.axis)}</text>
  ${grid}
  <polygon points="${areaPoints}" fill="url(#growth-fill)"/>
  <polyline points="${cumulativePoints}" fill="none" stroke="#0f766e" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
  ${renameMarker}
  <circle cx="${endX}" cy="${endY}" r="5" fill="#ffffff" stroke="#0f766e" stroke-width="3"/>
  <text x="${endX - 10}" y="${Math.max(plotTop + 14, endY - 12)}" text-anchor="end" class="endpoint">${xml(formatCount(projectTotal, locale))}</text>
  ${xTicks}
  <text x="${left}" y="496" class="subtitle">${xml(copy.source)} · ${xml(copy.note)}</text>
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
  const svg = renderSvg(document, "en");
  const svgZhCn = renderSvg(document, "zh-CN");
  assert(!svg.includes("NaN") && !svgZhCn.includes("NaN"), "generated SVG contains NaN");
  await mkdir(args.outputDir, { recursive: true });
  await writeAtomic(path.join(args.outputDir, "npm-downloads.json"), `${JSON.stringify(document, null, 2)}\n`);
  await writeAtomic(path.join(args.outputDir, "npm-downloads.svg"), svg);
  await writeAtomic(path.join(args.outputDir, "npm-downloads.zh-CN.svg"), svgZhCn);
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
