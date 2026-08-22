# Distribution sequence

Distribution is intentionally separate from local implementation and requires explicit publication authorization. The status below records what was actually published for `v0.2.0`; an open submission or prepared article is not counted as a completed destination.

1. **Complete:** release documents were finalized on commit `7e9f1e3e50cdf464de59edf3a81cebc7f06c2ed8`; exact-package, checksum, clean-tree, source/runtime identity, and nine-job release-commit CI checks passed while preserving the explicit unverified native surfaces.
2. **Complete:** `dsh-session-insights@0.2.0`, annotated tag `v0.2.0`, and the matching GitHub Release were published. npm metadata, the registry tarball, remote peeled tag, Release identity, asset checksums, and tag CI were read back independently.
3. **Submitted, awaiting upstream:** the repository now carries the `dsh-plugin` and `dsh-bundle` discovery topics. [`dshworks/awesome-dsh-plugins` PR #54](https://github.com/dshworks/awesome-dsh-plugins/pull/54) proposes the Bundle under `observability` and `memory`; its check passes, but listing completion remains pending until merge. `/session-insights` continues to coexist with `dsh-insights`.
4. **Deferred for review:** a bilingual launch-article candidate may be prepared locally, but no article destination should be created or published until the author reviews and reauthorizes the exact candidate and target set.
5. **Deferred with the article:** Chinese developer-channel distribution and English Reddit, Hacker News, Medium, or DSH-discussion outreach must wait for the reviewed canonical article and independent destination authorization/readback.
6. **Post-release observation:** collect concrete install-to-first-report failures and semantic fallback reasons when user evidence becomes available; do not fabricate an outreach wave or adoption signal.

PyPI and generic Skill catalogs are not `v0.2.0` launch gates. The npm package and GitHub Release are live; the marketplace PR is pending; article and external-post publication remain deliberately deferred and are not release blockers.
