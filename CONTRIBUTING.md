# Contributing

Contributions should preserve the local-first privacy model and DSH-only public interface.

## Before opening a pull request

1. Use only synthetic session data. Never commit real transcripts, reports, caches, credentials, machine paths, or generated runtime state.
2. Keep deterministic and semantic claims separate. A model-derived observation must remain marked as inferred.
3. Do not add an upload path, native plugin execution, or a new provider dependency without a dedicated design and security review.
4. Update English and Chinese documentation together when behavior, compatibility, privacy, or validation scope changes.
5. Run the development commands in the README.

Compatibility claims require native acceptance against an exact DSH version. CI results alone may be reported only as automated test coverage.

## DSH support policy

Support only the explicitly verified minimum baseline or the latest DSH release after verification. Do not maintain historical host versions or promise compatibility with every version between verified targets. When changing the support baseline, update both READMEs and record the exact DSH version and validation scope. A new upstream release, an old installation threshold, or a historical acceptance record does not establish current support.

Retained readers and fixtures for older session-log formats cover data that can remain after a host upgrade; they do not require maintaining the old host. Ask users to reproduce compatibility issues on a supported, verified baseline.
