import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectPackageSeries, normalizeRangePayload, reconcilePointPayload } from "../scripts/npm-download-stats.mjs";

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
