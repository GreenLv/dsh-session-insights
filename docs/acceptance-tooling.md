# Acceptance tooling and CI coverage

The source CI runs the Python suite for each declared OS/Python combination.
The Node suite runs once for macOS/rc.2 and in each DSH contract cell. The
contract cells cover rc.3 on Linux, macOS and Windows, rc.2 on Linux and
Windows, and the separately declared Node 24 cell. Target-sensitive tests
check the resolved package identity; a matrix label alone is not evidence of
the runtime actually used.

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
