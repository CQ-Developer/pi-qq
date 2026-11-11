# Project Guidelines

pi-qq is a pi extension that connects a QQ private chat to pi on your own machine through Tencent's QQ Bot C2C API. You can send text, voice, images, or files from QQ, and pi sends the results back.

## Releasing

Releases run entirely in GitHub Actions. Push a `v*` tag and `.github/workflows/release.yml`:

1. checks that the tag, `package.json`, and `package-lock.json` versions match;
2. runs lint, tests, typecheck, `format:check`, and `npm pack --dry-run`;
3. publishes to npm and creates a GitHub Release with the `.tgz` and `SHA256SUMS` attached.

Release notes come from the matching `CHANGELOG.md` section.

To release, bump the version, update `CHANGELOG.md`, tag the commit, and push. Do not run `npm publish` by hand or create GitHub Releases manually.

## CI

Regular pushes and pull requests run through `.github/workflows/ci.yml`, which runs lint, typecheck, tests, and `format:check`.
