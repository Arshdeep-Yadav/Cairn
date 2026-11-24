#!/bin/sh
# Cairn CLI installer — installs directly from GitHub, bypassing the unrelated
# npm package named "cairn" and the collision on "cairn-memory".
#
#   curl -fsSL https://raw.githubusercontent.com/Arshdeep-Yadav/Cairn/main/install.sh | sh
#
# Options:
#   CAIRN_REF=v0.1.0   install a specific tag/branch (default: main)
#   CAIRN_REPO=...     override the git remote (useful for forks/tests)
#   --uninstall        remove the globally installed CLI
set -eu

REPO="${CAIRN_REPO:-https://github.com/Arshdeep-Yadav/Cairn.git}"
REF="${CAIRN_REF:-main}"
PACKAGE="cairn-memory"

fail() {
  printf 'cairn install: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "requires $1"
}

if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "uninstall" ]; then
  need npm
  npm uninstall -g "$PACKAGE" >/dev/null 2>&1 || true
  printf 'Cairn CLI removed. Your .cairn/ vault was left untouched.\n'
  exit 0
fi

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,12p' "$0"
  exit 0
fi

need node
need npm

node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"
node_minor="$(node -p "process.versions.node.split('.')[1]" 2>/dev/null || printf '0')"
if [ "$node_major" -lt 20 ] 2>/dev/null || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 19 ] 2>/dev/null; }; then
  fail "Node.js 20.19 or newer is required (found $(node -v 2>/dev/null || printf 'unknown'))"
fi

tmp="${TMPDIR:-/tmp}/cairn-install.$$"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
src="$tmp/Cairn"

if command -v git >/dev/null 2>&1; then
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$src" \
    || fail "could not clone $REPO (ref: $REF)"
else
  need curl
  need tar
  slug="$(printf '%s' "$REPO" | sed -E 's#^(https?://[^/]+/|git@[^:]+:)##; s#\.git$##')"
  archive="$tmp/cairn.tar.gz"
  if ! curl -fsSL "https://codeload.github.com/$slug/tar.gz/refs/heads/$REF" -o "$archive"; then
    # CAIRN_REF may be a tag, which lives under refs/tags rather than refs/heads.
    curl -fsSL "https://codeload.github.com/$slug/tar.gz/refs/tags/$REF" -o "$archive" \
      || fail "could not download Cairn (ref: $REF)"
  fi
  mkdir -p "$src"
  tar -xzf "$archive" -C "$src" --strip-components=1 2>/dev/null \
    || tar -xzf "$archive" -C "$src" 2>/dev/null \
    || fail "could not extract the Cairn archive"
  if [ ! -f "$src/package.json" ]; then
    nested="$(find "$src" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    if [ -n "$nested" ] && [ -f "$nested/package.json" ]; then
      src="$nested"
    fi
  fi
fi

[ -f "$src/package.json" ] || fail "downloaded source is missing package.json"

printf 'Building Cairn from %s (%s)...\n' "$REPO" "$REF"
cd "$src"
# Skip prepare/prepack: the explicit build below runs once, not three times.
npm ci --silent --ignore-scripts 2>/dev/null || npm install --silent --ignore-scripts
npm run build --silent
# Install from a packed tarball. `npm install -g .` links to the source folder
# on some platforms, which breaks when this installer cleans up its temp dir.
tarball="$(npm pack --silent --ignore-scripts | tail -n 1)"
[ -f "$tarball" ] || fail "npm pack did not produce a tarball"
npm install -g "$tarball" --silent

printf '\nCairn installed.\n'
cairn --version 2>/dev/null || true
printf '\nNext: cd into your project and run\n'
printf '  cairn start --connect claude-code --git-hooks\n'
