# Selene — development tasks. Run `just` (or `just --list`) to see them.
# Shared recipes (rust, frontend, ci, build-signed, sweep) come from the
# ci-workflows clone: `ln -s /path/to/ci-workflows ~/.ci-workflows`.
import? '~/.ci-workflows/common.just'

# Share one target/ across the main checkout and every git worktree. A fresh
# worktree otherwise starts cold and rebuilds every dependency (minutes);
# pointing it at the main checkout's target/ keeps them warm.
# ponytail: cargo locks the target dir, so two builds in different worktrees
# serialise instead of running in parallel — still far cheaper than a cold
# rebuild. Falls back to ./target outside a git checkout.
export CARGO_TARGET_DIR := `dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$PWD/.git")"` / "target"

# Show available recipes.
default:
    @just --list

# Run the app in development (Vite dev server + Tauri, hot reload).
dev:
    pnpm tauri dev

# `just dev` ad-hoc-signs the binary with a fresh identity every rebuild, so the
# keychain re-prompts each run and "Always Allow" never sticks. This recipe
# keeps one signing identity across rebuilds, so a single "Always Allow"
# persists. Tradeoff: runs a bundle, so there's NO hot reload — use `just dev`
# for fast iteration and this when the keychain prompt is in your way.
# One-time setup: create a self-signed *Code Signing* certificate named
# "Selene Dev" (Keychain Access → Certificate Assistant → Create a Certificate);
# to use a different name, edit src-tauri/tauri.dev-signed.conf.json.

# Build + launch a debug .app signed with a STABLE self-signed cert (macOS).
dev-signed: _signed-conf
    pnpm tauri build --debug --bundles app --config src-tauri/tauri.dev-signed.conf.json
    @just sweep
    open "$CARGO_TARGET_DIR/debug/bundle/macos/Selene.app"

# Tauri's own dmg step uses HFS+, which is broken on macOS 26+, so we build
# the .app here and package the .dmg ourselves (APFS) via the shared make-dmg.sh.

# Build the production desktop bundle (.app + .dmg).
build:
    pnpm install
    pnpm tauri build --bundles app
    ~/.ci-workflows/scripts/make-dmg.sh
    @just sweep

# Build the signed release and copy it straight into /Applications.
install-signed: build-signed
    rm -rf "/Applications/Selene.app"
    cp -R "$CARGO_TARGET_DIR/release/bundle/macos/Selene.app" "/Applications/Selene.app"
    @echo "Installed → /Applications/Selene.app"

# Type-check the whole Rust workspace without building.
check:
    cargo check --workspace

# Run only the core data-layer unit tests.
test-core:
    cargo test -p selene-core

# The default workspace build doesn't compile the off-by-default drivers.
# Docker-backed tests stay `#[ignore]`d, so only unit tests and SQLite's
# in-process tests run. CI passes this as the `extra-recipe` of tauri-ci.yml.
# Standalone: no common.just dependency.

# Clippy + tests for the sqlite, postgres, mysql and mongodb drivers.
drivers-check:
    cargo clippy -p selene-core --features "sqlite postgres mysql mongodb" --all-targets -- -D warnings
    cargo test -p selene-core --features "sqlite postgres mysql mongodb"

# testcontainers, ephemeral ports. Each test binary is scoped on its own so the
# lib's `live_keychain_round_trip` test (`#[ignore]`d, needs a real Secret
# Service) is not run. SQLite's tests are in-process and run in `drivers-check`.
# Run nightly by integration.yml. Standalone: no common.just dependency.

# Docker-backed integration tests for MSSQL, PostgreSQL, MySQL and MongoDB.
test-integration:
    cargo test -p selene-core --features mssql --test mssql_integration -- --ignored
    cargo test -p selene-core --features postgres --test postgres_integration -- --ignored
    cargo test -p selene-core --features mysql --test mysql_integration -- --ignored
    cargo test -p selene-core --features mongodb --test mongodb_integration -- --ignored

# Format Rust + frontend.
format:
    cargo fmt --all
    pnpm format

# Set the version and sync it across Cargo.toml, tauri.conf.json, package.json.
# Usage: just version 0.2.0
version new:
    bash ~/.ci-workflows/scripts/sync-version.sh --set {{ new }}

# Verify the version is identical across all three manifests.
version-check:
    bash ~/.ci-workflows/scripts/sync-version.sh --check
