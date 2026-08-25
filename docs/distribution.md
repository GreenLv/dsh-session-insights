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
| [Awesome DeepSeek Harness](https://github.com/Dominic789654/awesome-deepseek-harness#session--memory-management) | `GreenLv/dsh-session-insights` | Listed | Entry visible in the generated list under "Session & Memory Management" (read back 2026-08-25) |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | `GreenLv/dsh-session-insights` (category `session`) | Listed | Listing merged via [PR #2680](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2680), read back from the generated README and the published catalog at `https://awesome-dsh-plugin.com/plugins.json` (2026-08-23). Screenshots registered via [PR #2937](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2937) (merged `4886a9a4`, 2026-08-24): the [storefront page](https://awesome-dsh-plugin.com/p/GreenLv/dsh-session-insights/) renders the `screenshots` array (2 images) plus the npm install command, and the in-app DSH plugin market renders the same catalog (catalog re-read 2026-08-25) |
| [dsh-market.com](https://dsh-market.com/) workshop | `dsh-session-insights` (category `tools`) | Listed | Community-index registration [PR #1055](https://github.com/zhu1090093659/dsh-web-ui/pull/1055) merged into `dev` (merge commit `05c57c8a`) then deployed to `main`; read back from the live manifest at `https://dsh-market.com/manifest/plugins.json` (generated 2026-08-24, 37 entries, rank 37) |
| [dshworks/awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins) | `GreenLv/dsh-session-insights` (category `bundle`) | Listed | Added via [PR #54](https://github.com/dshworks/awesome-dsh-plugins/pull/54) (merged 2026-08-24); entry read back from `data/plugins.json` (`status: verified`, npm linked). Registry site: `https://dsh.works/awesome-dsh-plugins/` |
