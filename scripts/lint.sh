#!/usr/bin/env bash
#
# Non-mutating quality gate. This is what `make check` and CI run.
#
# Two independent checks:
#   1. swift-format --lint  — formatting and the rules in .swift-format
#   2. swiftlint            — correctness-adjacent rules in .swiftlint.yml
#
# SwiftLint is optional locally (skipped with a warning) and required in CI,
# where REQUIRE_SWIFTLINT=1 turns its absence into a failure.
#
# macOS ships bash 3.2; keep this script free of bash 4+ features.

set -euo pipefail
cd "$(dirname "$0")/.."

status=0
sources="App Packages/JanelaKit/Sources Packages/JanelaKit/Tests"

echo "==> swift-format"
# shellcheck disable=SC2086  # word splitting of $sources into paths is intended
if ! xcrun swift-format lint --strict --recursive --parallel $sources; then
    echo "hint: run 'make format' to fix formatting." >&2
    status=1
fi

echo "==> swiftlint"
if command -v swiftlint >/dev/null; then
    swiftlint lint --quiet --strict || status=1
elif [[ "${REQUIRE_SWIFTLINT:-0}" == "1" ]]; then
    echo "error: SwiftLint is required in CI but was not found." >&2
    status=1
else
    echo "skipped (not installed)"
fi

exit "$status"
