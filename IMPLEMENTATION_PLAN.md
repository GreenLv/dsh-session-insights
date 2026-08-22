# DSH Session Insights — Native Plugin Implementation Plan

Status: approved for local implementation on 2026-08-21
Repository: this repository root (the directory containing this plan)
Target release: `dsh-session-insights@0.2.0`

## 1. Objective

Turn the existing local-first Python analyzer and Skill into a native DeepSeek
Harness Bundle that provides a Claude Code `/insights`-style retrospective while
remaining compatible with the existing file-log CLI.

The primary command will be `/session-insights`, not `/insights`, so the package
can coexist with the already-published `dsh-insights` plugin. The first public
plugin release must include both deterministic analysis and the model-assisted
semantic retrospective, with Chinese and English product output.

## 2. Fixed product decisions

- Package form: thin native DSH Bundle plus the existing Python analysis core.
- Main command: `/session-insights`.
- Launch scope: complete deterministic and semantic workflow; no reduced preview.
- Languages: `zh-CN` and `en` for the Dashboard and semantic output.
- Data source in plugin mode: official `ctx.sessionQuery.listSessions()` and
  `ctx.sessionQuery.readSession()` APIs.
- Compatibility: retain direct file-log CLI and Skill workflows.
- Orchestration: the current DSH agent processes semantic batches serially; do
  not spawn subagents.
- Privacy: stream raw session snapshots to the Python process over stdin; do not
  persist raw transcript copies in the insights workspace.
- Runtime: Python 3.11+ is a documented system requirement. The npm package has
  no install/build lifecycle scripts.

## 3. Deliverables

### Phase A — Bundle shell and session-query bridge

1. Add the npm package manifest with `dsh.bundle.patch` and a Cordis patch.
2. Add a dependency-free ESM plugin that injects `commands`, `tools`, and
   `sessionQuery`.
3. Register `/session-insights` and the plugin tools.
4. Stream versioned JSONL snapshots from `sessionQuery` to the bundled Python
   bridge and add an analyzer adapter for those snapshots.
5. Keep file-log parsing intact and isolate cache/source namespaces so file and
   session-query modes cannot silently contaminate one another.

### Phase B — Full command and tool workflow

Expose this command surface:

```text
/session-insights [--days N] [--project PATH] [--privacy MODE]
  [--analysis-privacy MODE] [--analysis-depth LEVEL]
  [--locale zh-CN|en] [--deterministic] [--resume] [--no-open]
```

Expose these tools:

- `session_insights_prepare`
- `session_insights_get_batch`
- `session_insights_submit_batch`
- `session_insights_get_aggregate`
- `session_insights_submit_aggregate`
- `session_insights_finalize`

The default command runs the complete semantic workflow. Each semantic phase may
receive one repair attempt; invalid model output then degrades to a deterministic
report instead of losing the whole run. Cancellation must terminate child
processes and leave a resumable, bounded workspace.

Run state belongs under `$DSH_HOME/insights/runs/<run-id>`. It may contain only
manifests, bounded sanitized evidence, validated semantic results, and rendered
reports. The insights session itself counts toward usage coverage but is excluded
from recommendations as `meta_analysis`.

### Phase C — Localization and public documentation

1. Add `locale` to configuration/report contracts.
2. Render the Dashboard consistently in Chinese or English from the same report
   schema.
3. Generate semantic prompts and validated semantic output in the selected
   language.
4. Update both READMEs, installation/usage documentation, limitations, privacy
   description, and release-facing distribution guidance.
5. Position the project as a local-first, evidence-backed alternative with a
   native plugin experience; do not claim it is the first or only DSH insights
   tool.

### Phase D — Verification

Required evidence before calling the implementation complete:

- existing analyzer and semantic tests still pass;
- session-query adapter fixtures match equivalent file-log analysis;
- Bundle manifest, command registration, tool schemas, and Python bridge tests;
- semantic prepare/batch/aggregate/finalize, repair/fallback, resume, and
  cancellation tests;
- `zh-CN` and `en` report contract and rendered-content tests;
- `npm pack --dry-run` audit proving expected files and no lifecycle scripts;
- native macOS smoke test in an isolated DSH home;
- Windows-native acceptance remains a separate release gate and must not be
  inferred from macOS or CI;
- Ubuntu CI may validate portability but does not replace native acceptance.

## 4. Promotion sequence after implementation

Promotion begins only after the package passes the applicable release gates:

1. publish the npm Bundle and create the GitHub release;
2. submit to the DSH plugin marketplace and `awesome-dsh-plugins`;
3. publish the bilingual launch article with a real `/session-insights` run,
   privacy boundary, comparison to adjacent tools, and reproducible install path;
4. distribute to Chinese developer channels first, then Reddit/Hacker News and
   English article channels;
5. collect installation-to-first-report failures and improve onboarding before
   broadening outreach.

## 5. Authority and publication boundary

This plan authorizes local repository implementation and proportional local
verification only. It does **not** authorize committing, pushing, publishing to
npm, creating a GitHub release or pull request, submitting to a marketplace,
posting articles, or changing external accounts. Those actions require separate
explicit authorization.

## 6. Continuation checklist

When resuming, start here:

1. Read this file and run `git status --short --branch`.
2. Preserve unrelated user changes; do not reset the worktree.
3. Find the first incomplete checkbox below and inspect the associated diff/tests.
4. Record validation evidence before advancing the checkbox.

- [x] Phase A: Bundle shell and session-query bridge
- [x] Phase B: complete command/tool semantic workflow
- [x] Phase C: bilingual product output and documentation
- [x] Phase D: focused tests, package audit, and available macOS native acceptance
- [ ] Publication gates separately authorized and completed

Local implementation evidence after the Windows review remediation: 11 Node tests
and 36 Python tests pass; fixture reconstruction, public-tree audit, package
dry-run, diff whitespace checks, exact English UI localization checks, and a
synthetic browser readback pass; the npm payload contains 17 intended files; an
isolated macOS DSH `0.1.1-rc.1` profile installed, composed, and started the
Bundle. A third independent macOS DSH retest subsequently closed the alias-path
and English semantic-rendering findings with no remaining macOS release blocker.
Windows-native Bundle acceptance on base commit `ada5f10` exercised the local-link
lifecycle and exposed a missing aggregate enum contract; remediation source
commit `1fe5bc4` passed the nine-job remote CI matrix and awaits focused real-model revalidation. A real-model
`zh-CN` semantic review, commit/push, npm publication, tag/Release,
marketplace submission, and article publication remain separate pending gates.
