# Contributing to XDrive

## Development checks

Use the toolchain versions in `.node-version` and `go.mod`, then run:

```sh
make web-install
make test
```

The browser Chromium/WebKit E2E suites are not part of GitHub Actions. The CI workflow runs the project checks, Go race tests, and Linux cross-builds.

## Stable releases

Prepare the release metadata and exact format approval in `docs/format-version-matrix.json`, update the public version in `README.md`, then commit and push the release source to `main`. Wait for its CI run to pass, or push the matching stable tag while that run is still in progress; the tag workflow waits for that exact `main` commit's CI result.

Create and push an annotated stable tag pointing at the tested commit:

```sh
git tag -a vMAJOR.MINOR.PATCH <tested-commit> -m "Release XDrive vMAJOR.MINOR.PATCH"
git push origin vMAJOR.MINOR.PATCH
```

The tag workflow rejects tags that do not point to a commit on `main`, checks the exact format approval and successful CI run, restores the embedded web assets from that run, then builds the Linux amd64 and arm64 archives and publishes the GitHub Release with `SHA256SUMS`. A failed or missing `main` CI run prevents publication. Chromium/WebKit E2E tests are not added to this workflow.

For a local full test-and-package pass, use `scripts/release.sh vMAJOR.MINOR.PATCH`. `scripts/package-release.sh` is the lower-level packaging step used by CI after it verifies the full `main` CI result; it does not run the test suite by itself.

The v1.3.7 release is the immutable updater bridge. It must include both architectures' complete `-package.tar.gz` distributions and the original five-member bootstrap artifacts. Later stable releases reuse the verified v1.3.7 bootstrap bytes under the legacy download names while shipping their own complete packages. The checksum manifest covers all four artifacts, and the release workflow uploads all four. Never replace the published bridge or put a full resource package under a legacy artifact name. See [release package protocol](docs/release-packages.md).

Add product resources under `release/files/`, which local packaging and CI collect automatically; `scripts/package-release.sh VERSION --files-dir DIRECTORY` can override that source directory. All supplied paths are relative to the application installation directory and are automatically included in the release manifest, installation, resource removal, and rollback. Bootstrap file collisions, links and unsupported paths are rejected. For offline packaging after v1.3.7, `--bridge-dir DIRECTORY` supplies the original bridge archives and their original `SHA256SUMS`.
