import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildStatsDocument,
  collectPackageSeries,
  normalizeRangePayload,
  reconcilePointPayload,
  renderSvg,
  resolveLatestCompleteDay,
} from "../scripts/npm-download-stats.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/npm-downloads-range.json", import.meta.url), "utf8"));
const expected = { packageName: "dsh-session-insights", start: "2026-08-22", end: "2026-08-25" };

test("normalizes an unsorted range and zero-fills a missing date", () => {
  const daily = normalizeRangePayload(fixture.range, expected);
  assert.deepEqual(daily, [
    { day: "2026-08-22", downloads: 2 },
    { day: "2026-08-23", downloads: 0 },
    { day: "2026-08-24", downloads: 3 },
    { day: "2026-08-25", downloads: 4 },
  ]);
  assert.equal(reconcilePointPayload(fixture.point, expected, daily), 9);
});

test("accepts a zero-download period", () => {
  const zeroExpected = { packageName: "dsh-session-insights", start: "2026-08-22", end: "2026-08-22" };
  const daily = normalizeRangePayload({ ...zeroExpected, package: zeroExpected.packageName, downloads: [] }, zeroExpected);
  assert.deepEqual(daily, [{ day: "2026-08-22", downloads: 0 }]);
  assert.equal(reconcilePointPayload({ ...zeroExpected, package: zeroExpected.packageName, downloads: 0 }, zeroExpected, daily), 0);
});

test("fails on a point/range total mismatch", () => {
  const daily = normalizeRangePayload(fixture.range, expected);
  assert.throws(() => reconcilePointPayload({ ...fixture.point, downloads: 10 }, expected, daily), /range\/point mismatch/);
});

test("rejects malformed range values", () => {
  const malformed = { ...fixture.range, downloads: [{ day: "2026-08-22", downloads: -1 }] };
  assert.throws(() => normalizeRangePayload(malformed, expected), /invalid download count/);
});

test("fails without writing when the npm API request fails", async () => {
  const spec = { package: "dsh-session-insights", label: "dsh-session-insights", color: "#2563eb", start: "2026-08-22" };
  await assert.rejects(collectPackageSeries(spec, "2026-08-22", async () => ({ ok: false, status: 503 })), /HTTP 503/);
});

test("uses the latest complete npm day by default", async () => {
  const specs = [{ package: "dsh-session-insights", start: "2026-08-22" }];
  const fetchImpl = async () => new Response(JSON.stringify({
    package: "dsh-session-insights",
    start: "2026-08-29",
    end: "2026-08-29",
    downloads: 21,
  }), { status: 200 });
  assert.equal(await resolveLatestCompleteDay(specs, fetchImpl), "2026-08-29");
});

test("rejects malformed last-day metadata instead of publishing a partial period", async () => {
  const specs = [{ package: "dsh-session-insights", start: "2026-08-22" }];
  const fetchImpl = async () => new Response(JSON.stringify({
    package: "wrong-package",
    start: "2026-08-29",
    end: "2026-08-29",
    downloads: 21,
  }), { status: 200 });
  await assert.rejects(() => resolveLatestCompleteDay(specs, fetchImpl), /package mismatch/);
});

test("shows every x-axis date when all labels fit", () => {
  const spec = { package: "dsh-session-insights", label: "dsh-session-insights", color: "#2563eb", start: "2026-08-22" };
  const document = buildStatsDocument(
    { schema: 1, title: "fixture", project: "dsh-session-insights", packages: [spec] },
    [{ spec, downloads: normalizeRangePayload(fixture.range, expected), sources: [] }],
    "2026-08-30T04:37:00.000Z",
    "2026-08-29",
  );
  const svg = renderSvg(document, "en");
  const labels = [...svg.matchAll(/class="axis">(\d{4}-\d{2}-\d{2})<\/text>/g)].map((match) => match[1]);
  assert.deepEqual(labels, [
    "2026-08-22",
    "2026-08-23",
    "2026-08-24",
    "2026-08-25",
    "2026-08-26",
    "2026-08-27",
    "2026-08-28",
    "2026-08-29",
  ]);
});

test("adapts x-axis tick density for long periods while preserving endpoints", () => {
  const spec = { package: "dsh-session-insights", label: "dsh-session-insights", color: "#2563eb", start: "2026-08-22" };
  const document = buildStatsDocument(
    { schema: 1, title: "fixture", project: "dsh-session-insights", packages: [spec] },
    [{ spec, downloads: normalizeRangePayload(fixture.range, expected), sources: [] }],
    "2026-10-02T04:37:00.000Z",
    "2026-10-01",
  );
  const svg = renderSvg(document, "en");
  const labels = [...svg.matchAll(/class="axis">(\d{4}-\d{2}-\d{2})<\/text>/g)].map((match) => match[1]);
  assert.ok(labels.length > 5 && labels.length <= 11);
  assert.equal(labels[0], "2026-08-22");
  assert.equal(labels.at(-1), "2026-10-01");
});

test("renders separate cumulative-only English and Chinese charts", () => {
  const spec = { package: "dsh-session-insights", label: "dsh-session-insights", color: "#2563eb", start: "2026-08-22" };
  const document = buildStatsDocument(
    { schema: 1, title: "fixture", project: "dsh-session-insights", packages: [spec] },
    [{ spec, downloads: normalizeRangePayload(fixture.range, expected), sources: [] }],
    "2026-08-26T04:37:00.000Z",
    "2026-08-25",
  );
  const english = renderSvg(document, "en");
  const chinese = renderSvg(document, "zh-CN");
  assert.match(english, /dsh-session-insights npm download growth/);
  assert.match(english, /Cumulative downloads/);
  assert.match(english, /All available history · 2026-08-22 → 2026-08-25/);
  assert.match(chinese, /dsh-session-insights npm 下载增长/);
  assert.match(chinese, /累计下载量/);
  assert.match(chinese, /全量历史 · 2026-08-22 → 2026-08-25/);
  assert.doesNotMatch(english, /Daily npm downloads/);
  assert.doesNotMatch(chinese, /每日 npm 下载量/);
  assert.match(english, /<title id="chart-title">/);
  assert.match(chinese, /<desc id="chart-desc">/);
  assert.doesNotMatch(`${english}${chinese}`, /NaN/);
});
