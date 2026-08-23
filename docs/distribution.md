# Distribution status

## Published v0.2.0 destinations

The following `v0.2.0` destinations have been published and independently read back:

1. [`dsh-session-insights@0.2.0` on npm](https://www.npmjs.com/package/dsh-session-insights) is published, and `latest` resolves to `0.2.0`. The registry tarball matches the accepted release artifact.
2. [GitHub Release `v0.2.0`](https://github.com/GreenLv/dsh-session-insights/releases/tag/v0.2.0) is published as a non-draft, non-prerelease release. Its annotated tag and downloadable assets match the accepted release identity.
3. [dsh.pub](https://dsh.pub/en/plugins/dsh-session-insights/) has a public plugin entry. Its [submission PR #29](https://github.com/dsh-pub/dsh-pub/pull/29) was merged and the directory deployment completed successfully.

The repository `package.json` declares `dsh.engines.dsh` (`>=0.1.0-rc.8`); the published `0.2.0` tarball predates that declaration, which takes effect on the next npm release.

Exact package, checksum, tag, Release, CI, and native-platform evidence remains recorded in the [v0.2.0 acceptance record](acceptance/v0.2.0-candidate.md).

## Community indexes and marketplaces

| Channel | Entry | Status | Evidence |
|---|---|---|---|
| Awesome DeepSeek Harness | `GreenLv/dsh-session-insights` | Listed | Entry visible in the generated list |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | `GreenLv/dsh-session-insights` (category `session`) | Listed | Merged via [PR #2680](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2680); read back from the generated README and the published catalog at `https://awesome-dsh-plugin.com/plugins.json` (2026-08-23). Storefront page: `https://awesome-dsh-plugin.com/p/GreenLv/dsh-session-insights/`; the in-app DSH plugin market renders the same catalog |
| awesome-dsh-plugin market screenshots | Keyed by `https://github.com/GreenLv/dsh-session-insights` | Pending merge | Screenshot registration PR to `data/screenshots.json`; update this row after merge and re-read the catalog |
| [dsh-market.com](https://dsh-market.com/) workshop | `dsh-session-insights` (category `tools`) | Pending merge | Community-index registration PR to `zhu1090093659/dsh-web-ui` (`packages/dsh-community-plugins/community.json`); after merge, the entry is deployed to dsh-market.com by `deploy-market.yml` — update this row after a public readback |
