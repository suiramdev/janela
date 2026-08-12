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
