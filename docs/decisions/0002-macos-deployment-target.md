# 0002. Target macOS 15

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

Janela's audience is macOS developers. That population upgrades faster than the
general Mac user base — they need current Xcode, which needs a current macOS — so
the usual conservatism about deployment targets applies weakly.

Against that, each macOS version we drop buys concrete API:

- `NavigationSplitView` column-width control, `ContentUnavailableView`, and the
  `TabView`/`Tab` builder used in Settings.
- Modern `@Observable` behaviour and `@Bindable` in the forms we rely on.
- Window and toolbar APIs (`.windowStyle`, `.windowToolbarStyle(.unified(showsTitle:))`)
  that let the app avoid AppKit for chrome.

Supporting an older floor means either conditional compilation around each of
these or reimplementing them, and the reimplementations are where a "native" app
starts feeling non-native.

## Decision

Deployment target is **macOS 15.0**, set in exactly two places that must agree:
`Packages/JanelaKit/Package.swift` (`platforms:`) and `project.yml`
(`MACOSX_DEPLOYMENT_TARGET`).

We build against the macOS 26 SDK with Xcode 26.

## Consequences

**Good.** SwiftUI is usable for essentially all chrome, so AppKit appears only
where it genuinely must: the terminal view. No availability shims in view code.

**Bad.** Users on macOS 14 and earlier cannot run Janela. We accept this; it is a
developer tool, not a utility for the general public.

**Subtle.** Building against a newer SDK than the deployment target means
`@available` checks are still required for anything macOS 26 introduced. The
compiler enforces this, so it is a nuisance rather than a risk.

## Alternatives considered

**macOS 14 (Sonoma).** Roughly one more year of machines. Rejected: it costs
availability checks in the exact APIs the UI is built from, for users who by
definition are running current developer tooling.

**macOS 26 only.** Tempting — it is the SDK we build against, and it would let us
adopt the newest APIs unconditionally. Rejected as too aggressive for a v1 with no
users yet; there is no specific macOS 26 API we currently need.

## Revisit when

- Apple ships macOS 27, at which point macOS 15 becomes N-2 and raising the floor
  to 16 costs almost nothing.
- A specific macOS 26 API becomes load-bearing enough that the availability checks
  outweigh the lost audience.
