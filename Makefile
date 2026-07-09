.PHONY: build dev preview lint fmt typecheck checkall test

# Local npm binaries. Invoked by direct path (not bare names) because the macOS
# default GNU make 3.81 does not honor recipe-exported PATH for command lookup.
BIN := ./node_modules/.bin

build:
	$(BIN)/vite build
dev:
	$(BIN)/vite
preview:
	$(BIN)/vite preview
lint:
	$(BIN)/eslint src
fmt:
	$(BIN)/prettier --write "src/**/*.{js,css}"
typecheck:
	$(BIN)/tsc --noEmit -p jsconfig.json
checkall: lint typecheck build
test:
	@echo "no test suite"
