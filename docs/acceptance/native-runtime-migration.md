# Native runtime migration — 0.4.0

Version 0.4.0 replaces the Bundle's Python bridge with Node.js snapshot analysis and semantic validation. These checks cover the source and packaged runtime; no user DSH Profile was modified. The existing exact DSH peer baseline is unchanged. Historical native acceptance of the Python implementation does not establish acceptance of this new runtime.

0.4.0 将 Bundle 的 Python bridge 替换为 Node.js 快照分析和语义校验。本记录覆盖源码和打包后的运行时，未修改用户 DSH Profile。DSH 精确 peer 基线保持不变；旧 Python 实现的宿主验收不覆盖新运行时。

## Implementation and boundaries

- `plugin/lib/worker.js` performs cancellable CPU analysis with an empty environment and no inherited Node startup arguments. There is no Python discovery, import-path forwarding, subprocess launcher or dynamic code evaluation in the native module graph.
- `plugin/lib/analyzer.js` consumes in-memory snapshots; `rules.js` shares declarative vocabulary and patterns with the retained Python CLI. `scripts/build_native_rules.py --check` fails when those declarations drift.
- `plugin/lib/storage.js` owns mutable native artifacts. Operations require a marked direct run directory, validate every descendant, reject symbolic/hard links and special files, bound reads, and atomically replace files. POSIX creation modes are private. The filesystem is not an OS sandbox against a hostile process sharing the account; Windows permissions use the parent ACL.
- `plugin/lib/semantic.js` validates batch membership, evidence ownership, enums, privacy and prohibited completion fields before writes. Failed replacements leave previous valid outputs intact. Explicit tool failure dominates success-looking output text.
- Cleanup previews one marked run, then deletes only that run on explicit confirmation. Native runs retain validated outputs for resume, but write no shared semantic cache. Legacy runs and CLI caches remain untouched; legacy manifests cannot be resumed by the new Bundle.
- The report schema and dashboard are retained. Deterministic summary wording is refreshed. Analysis is bounded to 2,000 selected snapshots / 64 MiB serialized input; exceeding that bound produces an error instead of a partial result.

## Reproducible checks

```bash
python -m unittest discover -s tests -v
python scripts/build_native_rules.py --check
npm test
python scripts/build_fixture.py --check
python scripts/audit_public_tree.py --root .
```

Local macOS checks on 2026-09-20 passed:

- Python suite, including legacy and V3 snapshot comparisons for all three privacy modes and both languages. Comparisons cover every legacy total, session-summary field except the changed failure-rule version, complete task-family records, projects, role/platform metrics, usage profiles and interaction metrics. Additional retry, denied-approval and incomplete-turn scenarios are compared. This is fixture equivalence, not a claim that all possible sessions are equivalent.
- JavaScript tests for deterministic output, prepare/resume, cancellation, complete semantic finalization, explicit fallback, metrics skip, redaction, surface replacement, token deduplication, selection diversity, invalid batch and aggregate submissions, traversal, symlinks, hard links, tampered manifest paths, owner-only POSIX modes, and preview/confirmed cleanup with preserved source logs and other runs.
- npm pack checks verify all native modules, the shared dashboard and security documentation are shipped without tests or runtime data. An unpacked artifact generated English and Chinese reports from six synthetic snapshots while Python configuration pointed to nonexistent paths.
- A temporary local browser preview displayed both generated reports with six sessions / 180 tokens. Filtering the Chinese report to one project displayed three sessions / 90 tokens. No page console errors were reported. The temporary tab and server were closed afterward. This local HTTP preview does not prove offline `file://` behavior or native DSH dispatch.
- Public-tree audit, fixture reproducibility, shared-rule freshness, documentation links and diff whitespace are checked separately from runtime behavior.

## Remaining external acceptance

A real DSH host must still exercise registration, slash-command dispatch, cancellation and a configured model's full semantic round trip against the new package bytes. Windows/Linux CI is portable test evidence, not an interactive native-host acceptance claim. No host restart, installed-profile migration, provider call or STORE approval is claimed here.

仍需在真实 DSH 宿主中验证新包的注册、斜杠命令分发、取消及配置模型的完整语义往返。Windows/Linux CI 只证明测试覆盖；本记录不声称已完成宿主重启、已安装 Profile 迁移、提供方调用或商城准入。
