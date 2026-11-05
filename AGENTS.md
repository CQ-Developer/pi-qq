# AGENTS.md

pi-qq is a pi extension that plugs a QQ private chat into pi on your own machine over Tencent's QQ Bot C2C API, so you can text, talk, or send pictures and files from your phone and get the results sent right back.

## Releasing

Releases are handled entirely by GitHub CI. Push a `v*` tag and `.github/workflows/release.yml` takes it from there: it checks that the tag, `package.json`, and `package-lock.json` all agree on the version, runs lint, tests, typecheck, `format:check`, and `npm pack --dry-run`, then publishes to npm and cuts a GitHub Release with the `.tgz` and `SHA256SUMS` attached. The release notes come straight out of the matching `CHANGELOG.md` section.

Regular pushes and PRs go through `.github/workflows/ci.yml`, which runs lint, typecheck, tests, and `format:check`.

So the drill is: bump the version, update `CHANGELOG.md`, tag it, push. Don't run `npm publish` by hand, and don't create Releases manually either — the workflow's got it.
