import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedRange = "0.1.5-rc.2";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("market-facing DSH metadata matches the verified support range", () => {
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
  assert.match(english, /current verified support baseline is `0\.1\.5-rc\.2`/);
  assert.match(chinese, /当前已验证的支持基线为 `0\.1\.5-rc\.2`/);
});
