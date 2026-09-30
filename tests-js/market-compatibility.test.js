import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";

const expectedRange = ">=0.2.0-rc.2";
const minimumAdmitted = "0.2.0-rc.2";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// The official RC.2 market consumer evaluates DSH peer ranges with
// node-semver includePrerelease:true; this suite models that evaluator, not
// a generic default-mode semver check.
const require = createRequire(import.meta.url);
const semver = require("semver");
const admitted = (version) =>
  semver.satisfies(version, expectedRange, { includePrerelease: true });
const evaluatePluginCompatibility = (metadata) => {
  const range = metadata.engines?.dsh;
  if (typeof range !== "string" || !semver.validRange(range))
    return { compatible: false, reason: "invalid engines.dsh range" };
  return { compatible: true };
};

test("market-facing DSH metadata matches the declared target range", () => {
  assert.equal(packageJson.engines?.dsh, expectedRange);
  assert.equal(packageJson.dsh?.engines?.dsh, expectedRange);

  const dshPeers = Object.entries(packageJson.peerDependencies ?? {})
    .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"));
  assert.ok(dshPeers.length > 0, "at least one DSH peer dependency is required");
  for (const [name, range] of dshPeers) {
    assert.equal(range, expectedRange, `${name} must match the market range`);
  }
  assert.ok(evaluatePluginCompatibility(packageJson).compatible);
});

test("version vector: RC.1 is refused and later releases remain admitted", () => {
  // Refused floor.
  assert.ok(!admitted("0.2.0-rc.1"));
  // Admitted: the floor itself, later RCs, stable releases and far-future
  // majors; a future tuple prerelease must not be rejected by static tables.
  for (const version of [
    minimumAdmitted,
    "0.2.0-rc.3",
    "0.2.0",
    "0.2.1-rc.1",
    "0.3.0-rc.1",
    "1.0.0",
    `${minimumAdmitted}+build.7`,
  ])
    assert.ok(admitted(version), version);
  // Invalid metadata is not silently admitted.
  assert.ok(!admitted("not-a-version"));
  assert.ok(!admitted("0.2"));
});

test("both README support summaries match the market range", async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8"),
  ]);
  assert.match(english, /The package requires `>=0\.2\.0-rc\.2`/);
  assert.match(english, /Contract and service tests cover synthetic V4 input/);
  assert.match(english, /artifact-specific host, model, platform and browser results/);
  assert.match(english, /docs\/acceptance\/v0\.5\.1-candidate\.md/);
  assert.match(chinese, /软件包要求 `>=0\.2\.0-rc\.2`/);
  assert.match(chinese, /契约与服务测试覆盖合成 V4 输入/);
  assert.match(chinese, /具体制品的宿主、模型、平台与页面验收结果分别记录/);
  assert.match(chinese, /docs\/acceptance\/v0\.5\.1-candidate\.md/);
});
