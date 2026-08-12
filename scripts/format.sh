#!/usr/bin/env bash
#
# Format every Swift source in place using the toolchain's swift-format.
# Configuration lives in .swift-format at the repo root.
#
# Note: macOS ships bash 3.2, so this script avoids bash 4+ features such as
# `mapfile`. swift-format's own --recursive does the file discovery for us, which
# also keeps .build checkouts out of scope because we name only our own trees.

set -euo pipefail
cd "$(dirname "$0")/.."

if ! xcrun --find swift-format >/dev/null 2>&1; then
    echo "error: swift-format not found in the Xcode toolchain." >&2
    exit 1
fi

xcrun swift-format format \
    --in-place --recursive --parallel \
    App Packages/JanelaKit/Sources Packages/JanelaKit/Tests

echo "Formatted."
