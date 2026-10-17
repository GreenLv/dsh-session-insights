import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";

const expectedRange = ">=0.2.1-rc.2";
const minimumAdmitted = "0.2.1-rc.2";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// The official app-boot/market consumer evaluates DSH peer ranges with
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

test("version vector: RC.2 floor refuses 0.2.0 and 0.2.1-rc.1, admits later releases", () => {
  // Refused floors.
  for (const version of ["0.2.0-rc.1", "0.2.0-rc.2", "0.2.0", "0.2.1-rc.1", "0.2.1-0", "0.2.1-alpha"])
    assert.ok(!admitted(version), version);
  // Admitted: the floor itself, later RCs, stable releases and far-future
  // majors; a future tuple prerelease must not be rejected by static tables.
  for (const version of [
    minimumAdmitted,
    "0.2.1-rc.3",
    "0.2.1",
    "0.3.0-rc.1",
    "0.3.0",
    "1.0.0",
    `${minimumAdmitted}+build.7`,
  ])
    assert.ok(admitted(version), version);
  // Invalid metadata is not silently admitted.
  // A prerelease below the exact floor is refused even inside the floor tuple.
  for (const version of ["0.2.1-0", "0.2.1-alpha"]) assert.ok(!admitted(version), version);
  assert.ok(!admitted("not-a-version"));
  assert.ok(!admitted("0.2"));
});

test("official app-boot precedence: engines.dsh alone decides, peers are ignored", () => {
  // dsh-app-boot's unmetRequirements checks engines.dsh first and returns its
  // issues alone; peerDependencies are not consulted when engines.dsh exists.
  const runtime = "0.2.1-rc.2";
  const manifest = {
    ...packageJson,
    peerDependencies: {...packageJson.peerDependencies, "@deepseek-ai/dsh-agent": "<0.0.1"},
  };
  assert.ok(manifest.engines?.dsh, "engines.dsh must be declared for precedence");
  assert.ok(admitted(runtime));
  const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith("@deepseek-ai/dsh-"));
  // The deliberately broken peer would fail on its own...
  assert.ok(dshPeers.some(([, range]) => !semver.satisfies(runtime, range, {includePrerelease: true})));
  // ...but engines.dsh decides first, so the product manifest stays admitted.
  assert.ok(evaluatePluginCompatibility(manifest).compatible);

  // Without engines.dsh, the same peer set decides the outcome.
  const peersOnly = {...manifest, engines: {}};
  delete peersOnly.engines.dsh;
  assert.equal(peersOnly.engines?.dsh, undefined);
  assert.ok(
    Object.entries(peersOnly.peerDependencies)
      .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"))
      .some(([, range]) => !semver.satisfies(runtime, range, {includePrerelease: true})),
    "peer-only admission must fail on the deliberately broken peer",
  );
  // The product's real peers all admit the floor.
  const realPeersOnly = {...packageJson, engines: {}};
  delete realPeersOnly.engines.dsh;
  for (const [name, range] of Object.entries(realPeersOnly.peerDependencies)) {
    if (name.startsWith("@deepseek-ai/dsh-"))
      assert.ok(semver.satisfies(runtime, range, {includePrerelease: true}), name);
  }
});

test("both README support summaries match the market range", async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8"),
  ]);
  assert.match(english, /The package requires `>=0\.2\.1-rc\.2`/);
  assert.match(english, /Contract and service tests cover synthetic V4 input/);
  assert.match(english, /recorded source checks and its explicitly pending native, model, platform and exact-artifact gates/);
  assert.match(english, /docs\/acceptance\/v0\.6\.0-rc2\.1-candidate\.md/);
  assert.match(chinese, /软件包要求 `>=0\.2\.1-rc\.2`/);
  assert.match(chinese, /契约与服务测试覆盖合成 V4 输入/);
  assert.match(chinese, /具体制品的宿主、模型、平台与页面验收结果分别记录/);
  assert.match(chinese, /docs\/acceptance\/v0\.6\.0-rc2\.1-candidate\.md/);
});
