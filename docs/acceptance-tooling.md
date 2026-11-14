# Acceptance tooling and CI coverage

The source CI runs the Python suite for each declared OS/Python combination.
Every cell installs and names the single current rc.3 runtime
(`tests/dsh-runtime`, exact `0.2.2-rc.3`); there is no separate compatibility
runtime and no compatibility lane. The Node suite runs in each DSH contract
cell. The contract cells cover the Node 24.9.0 floor on Linux, macOS and
Windows plus one Node 25 probe of the same rc.3 host.
Target-sensitive tests check the resolved package identity; a matrix label
alone is not evidence of the runtime actually used.

The dependency audit binds root production/full, the exact rc.3 runtime/host trees, and Python separately. Root and runtime findings always fail. The host tree may pass only as clean or under a maintainer decision in `config/host-dependency-risk.json` bound to the exact current product/host version, manifest/lock hashes, advisory set and reviewed report. The 2026-11-13 decision was bound to the rc.2 host for 0.8.1 and does not carry forward; until a new rc.3 decision is recorded, the raw finding exit remains 1 with status `unauthorized_findings` and the aggregate gate refuses. It is not a clean scan.

Profile acceptance witnesses the persisted source logs of its target and non-target fixtures before and after the real operation interval: loss, replacement, addition or read failure is never recorded as unchanged, and the operation, witness and cleanup outcomes stay separate terminal states.

The 0.8.0 Zod policy remains historical and cannot authorize anything current. Scanner errors, missing/skipped steps, cancellation, invalid JSON, input drift, capture/cleanup failures and unreviewed findings fail the job. Reassessment cannot erase a capture failure or change a receipt's tree/scope attribution. See the [security policy](../SECURITY.md#known-upstream-dependency-gap) for the exact current decision.

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
