#!/usr/bin/env bash
#
# One-time developer setup. Safe to re-run.

set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# ---- Prerequisites -----------------------------------------------------------

command -v xcodebuild >/dev/null || die "Xcode is required. Install it from the App Store."

REQUIRED_XCODE_MAJOR=26
xcode_version="$(xcodebuild -version | head -1 | awk '{print $2}')"
if [[ "${xcode_version%%.*}" -lt "$REQUIRED_XCODE_MAJOR" ]]; then
    die "Xcode ${REQUIRED_XCODE_MAJOR} or newer is required (found ${xcode_version})."
fi
say "Xcode ${xcode_version}"

swift_version="$(swift --version 2>&1 | grep -o 'Apple Swift version [0-9.]*' | awk '{print $4}')"
say "Swift ${swift_version:-unknown}"

# ---- Tools -------------------------------------------------------------------

if ! command -v xcodegen >/dev/null; then
    if command -v brew >/dev/null; then
        say "Installing XcodeGen"
        brew install xcodegen
    else
        die "XcodeGen is required and Homebrew was not found. See https://github.com/yonaskolb/XcodeGen"
    fi
fi
say "XcodeGen $(xcodegen --version 2>&1 | tail -1)"

# swift-format ships inside the Xcode toolchain from Xcode 16 onward, so there is
# nothing to install. Only warn if that ever stops being true.
if ! xcrun --find swift-format >/dev/null 2>&1; then
    warn "swift-format not found in the toolchain; 'make format' will not work."
fi

# SwiftLint is optional locally and required in CI.
if ! command -v swiftlint >/dev/null; then
    warn "SwiftLint not installed — 'make lint' will skip it. Install with: brew install swiftlint"
fi

# ---- Dependencies ------------------------------------------------------------

say "Resolving Swift package dependencies"
(cd Packages/JanelaKit && swift package resolve)

say "Generating Janela.xcodeproj"
xcodegen generate --quiet

cat <<'EOF'

Ready.

  make test     run the fast module tests
  make open     open the project in Xcode
  make check    everything CI checks

Read AGENTS.md before your first change.
EOF
