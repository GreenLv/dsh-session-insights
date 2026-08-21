# Contributing

Contributions should preserve the local-first privacy model and DSH-only public interface.

## Before opening a pull request

1. Use only synthetic session data. Never commit real transcripts, reports, caches, credentials, machine paths, or generated runtime state.
2. Keep deterministic and semantic claims separate. A model-derived observation must remain marked as inferred.
3. Do not add an upload path, native plugin execution, or a new provider dependency without a dedicated design and security review.
4. Update English and Chinese documentation together when behavior, compatibility, privacy, or validation scope changes.
5. Run the development commands in the README.

Compatibility claims require native acceptance against an exact DSH version. CI results alone may be reported only as automated test coverage.
