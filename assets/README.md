# Assets

Public-facing images for this repository. All screenshots are captured from reports
generated from the repository's fully synthetic test fixture — they contain no real
session content, paths, or credentials.

| File | Content | Source | sha256 |
|---|---|---|---|
| `social/hero.jpg` | Language-neutral hero/cover for the README and social previews (1600×900) | Reused from the author-owned publication cover of article `ART-000004` in `blog-content` (imagegen-generated project asset) | `5f7cf82348c8c78e725ee286b6d2676acc3a93a89c71a530c3a24ab85d9c463e` |
| `screenshots/dashboard-overview-en.png` | English deterministic dashboard overview (synthetic data, light theme) | Generated with `python3 -m dsh_session_insights report` against `tests/fixtures/synthetic-session.jsonl`-derived sessions | `c51fbbae73a09f5319f3ed48686b1454e0199d8f8c716c056e0cce6d650ca4ef` |
| `screenshots/dashboard-overview-zh.png` | Chinese deterministic dashboard overview (synthetic data, light theme) | Same pipeline with `--locale zh-CN` | `bc0392fa704b33b32bc8398dfbaf446ab4bb894612bccf4b65f9abb0d5152db5` |

Market screenshot registration (awesome-dsh-plugin `data/screenshots.json`) points at the
`raw.githubusercontent.com/GreenLv/dsh-session-insights/main/...` URLs of these files.
