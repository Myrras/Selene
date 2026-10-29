# Selene — development tasks. Run `just` (or `just --list`) to see them.
# Shared recipes (dev, dev-signed, build, build-signed, install-signed, check,
# test-core, format, version, version-check, ci, rust, frontend, sweep) come
# from the ci-workflows clone: `ln -s /path/to/ci-workflows ~/.ci-workflows`.
# Don't redefine them here (just rejects duplicates); see `just --list`.
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
