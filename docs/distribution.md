# Distribution sequence

Distribution is intentionally separate from local implementation and requires explicit publication authorization.

1. Finish v0.2 release gates: native Windows Bundle acceptance, remote CI, exact package readback, and a clean release commit.
2. Publish `dsh-session-insights@0.2.0` to npm and create a matching GitHub tag/Release only with separate authorization. Read back both identities independently.
3. Submit the Bundle to the DSH plugin marketplace and `dshworks/awesome-dsh-plugins` under observability/evidence or developer-tools categories. Use `/session-insights` in demos and state clearly that it coexists with `dsh-insights`.
4. Publish one bilingual launch article after the registry install path is reproducible. Lead with a real command-to-report flow, then explain the stdin/no-raw-copy privacy boundary, deterministic fallback, and comparison with adjacent DSH usage/insights tools.
5. Distribute the Chinese article to the user's established Chinese developer channels, then adapt the English edition for Reddit, Hacker News, Medium, and relevant DSH discussions. Verify every destination independently.
6. Track install-to-first-report failures and semantic fallback reasons before a second outreach wave.

PyPI and generic Skill catalogs are not v0.2 launch gates. The npm package, GitHub Release, marketplace submissions, articles, and external posts are all still unpublished local candidates; implementation approval does not authorize any of those actions.
