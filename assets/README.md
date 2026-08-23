# Assets

Public-facing images for this repository. All screenshots are captured from reports
generated from the repository's fully synthetic test fixture — they contain no real
session content, paths, or credentials.

| File | Content | Source | sha256 |
|---|---|---|---|
| `social/hero.jpg` | Language-neutral hero/cover for the README and social previews (1600×900) | Reused from the author-owned publication cover of article `ART-000004` in `blog-content` (imagegen-generated project asset) | `5f7cf82348c8c78e725ee286b6d2676acc3a93a89c71a530c3a24ab85d9c463e` |
| `screenshots/dashboard-overview-en.png` | English deterministic dashboard overview (synthetic data) | Generated with `python3 -m dsh_session_insights report` against `tests/fixtures/synthetic-session.jsonl`-derived sessions | `71a6682a8a62ee81d1325cc778c3b3523b702c94a9fab36e3f6d0c63edd07d6d` |
| `screenshots/dashboard-overview-zh.png` | Chinese deterministic dashboard overview (synthetic data) | Same pipeline with `--locale zh-CN` | `5ec3a89f45bbad90f250b5d39995770aa0ba8433d3efcacfe63c92d74333a2ac` |

Market screenshot registration (awesome-dsh-plugin `data/screenshots.json`) points at the
`raw.githubusercontent.com/GreenLv/dsh-session-insights/main/...` URLs of these files.
