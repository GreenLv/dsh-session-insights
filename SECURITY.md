# Security Policy

## Supported versions

No public version is currently released. Security fixes will target the latest maintained release after v0.1 is published.

## Reporting a vulnerability

Do not open a public issue for a suspected secret leak, unsafe installer behavior, or report-data exposure. Use GitHub's private vulnerability reporting for this repository when it is enabled. Until then, contact the maintainer through the private contact method on their GitHub profile and include only synthetic reproduction data.

Never attach real DSH sessions, reports, caches, credentials, or semantic work directories. State the affected version, platform, DSH version, privacy mode, and a minimal synthetic reproduction.

## Security boundaries

- Deterministic analysis can run offline.
- Semantic evidence is sent only when the user asks a DSH model to process prepared batches; provider handling follows that DSH configuration.
- Redaction is defense in depth, not a guarantee that arbitrary input is safe to disclose.
- The installer refuses unmarked and symbolic-link targets, but users should still review a checkout before installation.
