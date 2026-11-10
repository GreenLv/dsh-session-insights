# Acceptance tooling and CI coverage

The source CI runs the Python suite for each declared OS/Python combination.
Every cell installs and names the single current rc.1 runtime
(`tests/dsh-runtime`, exact `0.2.2-rc.1`); there is no separate compatibility
runtime. The Node suite runs in each DSH contract cell. The contract cells
cover the Node 24.9.0 floor on Linux, macOS and Windows plus one Node 25
probe of the same rc.1 host.
Target-sensitive tests check the resolved package identity; a matrix label
alone is not evidence of the runtime actually used.

The dependency audit distinguishes three outcomes: a clean scan passes only
with a valid, non-empty dependency inventory; a finding passes only under the
exact single-release, cohort-bound exception recorded in
`config/dependency-audit-exceptions.json` (for the 0.8.0 release: the
maintainer's 2026-11-06 decision, bound to the rc.1 cohort and the two
reviewed 18-entry report graph variants); anything else — network failure,
invalid JSON, a missing step, cancellation, or a new high/critical finding —
fails the job.

The profile and portable scripts use isolated test homes. A failed operation
or failed cleanup produces a failed outcome. Profile cleanup attempts each
owned resource independently and does not turn a missing receipt into a pass.
Stage, error type and bounded system error code may be retained as local JSON
diagnostics; arbitrary exception messages, subprocess output, credentials and
local paths are not copied into those diagnostics. They are classifications,
not full traces or proof that an installation or host loaded successfully.

Each invocation uses a new isolated test tree. These tools do not resume a
prior interrupted installation or silently reuse earlier acceptance evidence.
They refuse to overwrite a prior receipt or reuse an existing result directory;
the portable tool reserves its receipt path before installation. An interrupted
reservation remains a named obstruction: inspect the retained batch and use a
fresh result path rather than blindly removing it. If a profile or its owner
cannot be confirmed stopped, the tool retains the potentially active tree.
Inspect the recorded result and cleanup status before starting a new batch.
Source checks, exact packaged-artifact tests, real host loading and platform
GUI/model acceptance remain separate evidence.

Validate a historical reader-review receipt against the checkout it names or
the commit recorded by its release, since each receipt binds the exact
document bytes. Use the current README and changelog on `main` for updated
reader guidance.

Use the release receipt and its named tarball to verify a published npm package.
A local pack from `main` reflects the checkout's current files.
