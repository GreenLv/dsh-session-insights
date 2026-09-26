import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedRange = "0.1.7-rc.2";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("market-facing DSH metadata matches the declared target range", () => {
  assert.equal(packageJson.engines?.dsh, expectedRange);
  assert.equal(packageJson.dsh?.engines?.dsh, expectedRange);

  const dshPeers = Object.entries(packageJson.peerDependencies ?? {})
    .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"));
  assert.ok(dshPeers.length > 0, "at least one DSH peer dependency is required");
  for (const [name, range] of dshPeers) {
    assert.equal(range, expectedRange, `${name} must match the market range`);
  }
});

test("both README support summaries match the market range", async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8"),
  ]);
  assert.match(english, /The package targets `0\.1\.7-rc\.2`/);
  assert.match(english, /Contract and service tests cover synthetic V4 input/);
  assert.match(english, /artifact-specific host, model, platform and browser results/);
  assert.match(english, /docs\/acceptance\/v0\.5\.0-rc2-candidate\.md/);
  assert.match(chinese, /软件包仅要求 `0\.1\.7-rc\.2`/);
  assert.match(chinese, /契约与服务测试覆盖合成 V4 输入/);
  assert.match(chinese, /具体制品的宿主、模型、平台与页面验收结果分别记录/);
  assert.match(chinese, /docs\/acceptance\/v0\.5\.0-rc2-candidate\.md/);
});
