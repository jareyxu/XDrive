.PHONY: help check web-install web-check server-check scripts-check linux-runtime-check backup-resource-check folder-selection-resource-check build test

help:
	@printf '%s\n' 'make web-install  Install locked web dependencies' \
		'make web-check    Run web typecheck, lint, and production build' \
		'make server-check Run Go formatting check, vet, and tests' \
		'make scripts-check Check shell scripts and portable uninstall behavior' \
		'make linux-runtime-check Optional isolated native Linux internal tests (Docker image required)' \
		'make backup-resource-check Optional isolated 1C1G near-quota backup/verify workload (Docker required)' \
		'make folder-selection-resource-check Measure Chromium heap/time for maximum folder path preflight' \
		'make build        Build the embedded web app and xdrive binary' \
		'make test         Run all available project checks'

web-install:
	cd web && pnpm install --frozen-lockfile

web-check:
	cd web && ./node_modules/.bin/tsc -b && ./node_modules/.bin/oxlint && ./node_modules/.bin/vite build

server-check:
	test -z "$$(gofmt -l $$(find cmd internal -name '*.go' -type f 2>/dev/null))"
	go vet ./...
	go test ./...

build: web-check server-check
	mkdir -p dist
	go build -o dist/xdrive ./cmd/xdrive

scripts-check:
	bash -n scripts/install.sh scripts/upgrade.sh scripts/uninstall.sh scripts/release.sh
	node --check web/scripts/folder_selection_resource_check.mjs
	python3 tests/release_format_gate_test.py
	python3 tests/client_protocol_contract_test.py
	python3 tests/error_catalog_contract_test.py
	python3 tests/persistent_format_contract_test.py
	python3 tests/uninstall_test.py
	python3 tests/install_preflight_test.py
	python3 tests/install_completion_test.py
	python3 tests/upgrade_test.py
	python3 -c 'import ast, pathlib; ast.parse(pathlib.Path("scripts/backup_resource_check.py").read_text())'

# Optional validation only; Docker is not the deployment architecture.
linux-runtime-check:
	python3 scripts/check_linux_runtime.py --image debian:12-slim --output-dir output/linux-runtime

BACKUP_RESOURCE_BYTES ?= 10737418240
BACKUP_RESOURCE_REPORT ?= output/backup-resource/backup-near-quota.json

backup-resource-check:
	python3 scripts/backup_resource_check.py --bytes $(BACKUP_RESOURCE_BYTES) --output "$(BACKUP_RESOURCE_REPORT)"

folder-selection-resource-check:
	cd web && node scripts/folder_selection_resource_check.mjs

test:
	$(MAKE) web-check
	$(MAKE) server-check
	$(MAKE) scripts-check
	cd web && ./node_modules/.bin/vitest run
	cd web && node --test e2e/tls-proxy-check.mjs
