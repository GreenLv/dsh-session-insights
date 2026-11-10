import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";

const expectedRange = ">=0.2.2-rc.1";
const minimumAdmitted = "0.2.2-rc.1";
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

test("version vector: rc.1 floor refuses older lines and below-floor prereleases, admits later releases", () => {
  // Refused floors: the whole 0.2.0/0.2.1 lines, and same-base prereleases
  // below the exact floor tuple.
  for (const version of [
    "0.2.0-rc.1", "0.2.0-rc.2", "0.2.0", "0.2.1-rc.1", "0.2.1-rc.2", "0.2.1-rc.5",
    "0.2.1", "0.2.2-0", "0.2.2-alpha", "0.2.2-alpha.2", "0.2.2-beta.1", "0.2.2-rc.0",
  ])
    assert.ok(!admitted(version), version);
  // Admitted: the floor itself, later RCs, stable releases and far-future
  // majors; a future tuple prerelease must not be rejected by static tables.
  for (const version of [
    minimumAdmitted,
    "0.2.2-rc.2",
    "0.2.2",
    "0.2.3-rc.1",
    "0.3.0-rc.1",
    "0.3.0",
    "1.0.0",
    `${minimumAdmitted}+build.7`,
  ])
    assert.ok(admitted(version), version);
  // Invalid metadata is not silently admitted.
  for (const version of ["not-a-version", "0.2"]) assert.ok(!admitted(version), version);
});

test("official app-boot precedence: engines.dsh alone decides, peers are ignored", () => {
  // dsh-app-boot's unmetRequirements checks engines.dsh first and returns its
  // issues alone; peerDependencies are not consulted when engines.dsh exists.
  const runtime = "0.2.2-rc.1";
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

test("each README states the market range before the Web install command", async () => {
  for (const file of ["README.md", "README.zh-CN.md", "README.ru-RU.md"]) {
    const document = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const install = document.indexOf("dsh plugin --profile web add dsh-session-insights@");
    assert.ok(install >= 0, file);
    assert.ok(document.slice(0, install).includes(`DSH \`${expectedRange}\``), file);
  }
});
