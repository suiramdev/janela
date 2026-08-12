# Janela — developer entry points.
#
# Everything a contributor (human or agent) needs to do should be one `make`
# target. If a workflow requires remembering a command, it belongs here.
#
# Run `make help` for the list.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

PACKAGE_DIR := Packages/JanelaKit
PROJECT := Janela.xcodeproj
SCHEME := Janela
DERIVED := DerivedData

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

# ---- Setup -------------------------------------------------------------------

.PHONY: bootstrap
bootstrap: ## Install tooling and resolve dependencies
	@./scripts/bootstrap.sh

.PHONY: generate
generate: ## Regenerate Janela.xcodeproj from project.yml
	@xcodegen generate --quiet
	@echo "Generated $(PROJECT)"

.PHONY: open
open: generate ## Regenerate and open in Xcode
	@open $(PROJECT)

# ---- Build & test ------------------------------------------------------------
#
# The package is the fast path: `make build`/`make test` never touch Xcode, so
# they run in a couple of seconds and work fine from a coding agent. Use the
# `app-*` targets only when you actually need the .app bundle.

.PHONY: build
build: ## Build all modules (SwiftPM, fast)
	@cd $(PACKAGE_DIR) && swift build

.PHONY: test
test: ## Run all module tests (SwiftPM, fast)
	@cd $(PACKAGE_DIR) && swift test

.PHONY: app-build
app-build: generate ## Build the .app bundle
	@set -o pipefail && xcodebuild build \
		-project $(PROJECT) -scheme $(SCHEME) \
		-configuration Debug -destination 'platform=macOS' \
		-derivedDataPath $(DERIVED) \
		CODE_SIGNING_ALLOWED=NO | $(FORMATTER)

.PHONY: app-run
app-run: app-build ## Build and launch the app
	@open $(DERIVED)/Build/Products/Debug/Janela.app

# ---- Daemon ------------------------------------------------------------------
#
# The footgun of the two-process design is an old janelad staying resident while
# you iterate on a new one: the app then talks to code you edited ten minutes ago,
# or refuses the handshake outright. See docs/development.md § The daemon.

.PHONY: daemon-restart
daemon-restart: ## Stop janelad so the next connection starts the current build
	@pkill -x janelad 2>/dev/null && echo "Stopped janelad." || echo "No janelad running."
	@echo "launchd will start the current build on the next connection."
	@echo "Note: this closed any terminals it was holding — the same cost a user"
	@echo "pays after an app update, which is worth feeling."

.PHONY: daemon-status
daemon-status: ## Show whether janelad is running, and who is connected
	@pgrep -lf janelad || echo "janelad: not running"
	@lsof -U 2>/dev/null | grep janelad || echo "no clients connected"

# ---- Quality -----------------------------------------------------------------

.PHONY: format
format: ## Format all Swift sources in place
	@./scripts/format.sh

.PHONY: lint
lint: ## Check formatting and lint rules (non-mutating)
	@./scripts/lint.sh

.PHONY: check
check: lint test ## What CI runs; run this before pushing

# ---- Housekeeping ------------------------------------------------------------

.PHONY: clean
clean: ## Remove build artifacts
	@rm -rf $(DERIVED) $(PACKAGE_DIR)/.build $(PROJECT)
	@echo "Cleaned."

# xcbeautify if available, otherwise pass through.
FORMATTER := $(shell command -v xcbeautify 2>/dev/null || echo cat)
