# Contributing

Contributions should preserve the local-first privacy model and DSH-only public interface.

## Before opening a pull request

1. Use only synthetic session data. Never commit real transcripts, reports, caches, credentials, machine paths, or generated runtime state.
2. Keep deterministic and semantic claims separate. A model-derived observation must remain marked as inferred.
3. Obtain a dedicated design and security review before adding an upload path, native executable launch, or new provider dependency.
4. Update the English, Chinese and Russian READMEs together when behavior, compatibility, privacy, or validation scope changes. Update both changelogs when recording a release change.
5. Run the local checks below and report any relevant checks you could not run.

Compatibility claims require native acceptance against an exact DSH version. CI results alone may be reported only as automated test coverage.

## Local development checks

From the repository root, use Python 3.11 or later and Node.js 24.9.0 or later. The following commands use a POSIX shell. Install Python dependencies in a virtual environment if you do not want to modify your existing environment.

```bash
python3 -m pip install -e '.[dev]'
npm ci --ignore-scripts
npm ci --prefix tests/dsh-runtime --ignore-scripts
npm ci --prefix tests/dsh-host --ignore-scripts
DSH_RUNTIME="$PWD/tests/dsh-runtime" DSH_EXPECTED_VERSION=0.2.2-rc.3 \
  python3 -m unittest discover -s tests -v
DSH_RUNTIME="$PWD/tests/dsh-runtime" DSH_EXPECTED_VERSION=0.2.2-rc.3 npm test
python3 scripts/build_native_rules.py --check
python3 scripts/build_fixture.py --check
python3 scripts/audit_public_tree.py --root .
```

These checks use the synthetic fixture and DSH `0.2.2-rc.3` runtime (the exact acceptance target; the supported floor is `>=0.2.2-rc.3`). For the host contract, dependency audit and OS matrix, see [CI](.github/workflows/ci.yml). Native host, model and GUI acceptance are recorded separately, as explained in [acceptance tooling](docs/acceptance-tooling.md).

## DSH support policy

The package declares the minimum admitted DSH version in `package.json`. Admission by this version range does not establish that every later host has been tested. Record the exact DSH version, platform and scope of each verification, and update all maintained README languages when changing the baseline. A new upstream release or a historical acceptance record does not establish verification of another host.

Both the Bundle and the standalone CLI require V4 session data. Legacy parsers and fixtures support regression checks. Ask users to reproduce host compatibility issues on a verified DSH version when possible.
