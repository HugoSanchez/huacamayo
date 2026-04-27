# Vervo

A native macOS app for chatting with a local Hermes agent through a desktop UI.

## Architecture

- **Vervo/** -- SwiftUI macOS shell that hosts the chat UI
- **orchestrator/** -- local Node sidecar for Hermes sessions, streaming, persistence, and future tool integration
- **chat-ui/** -- bundled web chat frontend rendered inside the app

## Development

```sh
# Open the macOS app in Xcode
open Vervo.xcodeproj

# Run the local sidecar
cd orchestrator && npm install && npm run dev
```

### Managed Hermes startup

For local app testing, the clean path is:

- the app starts `orchestrator`
- `orchestrator` starts Hermes if needed

If Hermes was installed via the normal CLI flow, `orchestrator` will now auto-detect it and start:

```sh
hermes gateway run
```

`orchestrator` launches Hermes in an isolated Vervo profile under `~/.hermes/profiles/vervo`, seeded from your default Hermes config on first run. That avoids clashing with any other Hermes gateway you may already have running.

No extra Xcode env vars are required for the common case.

Optional Xcode scheme environment overrides:

```sh
# Explicit CLI entrypoint instead of auto-detect
VERVO_HERMES_COMMAND="/absolute/path/to/hermes"
VERVO_HERMES_ARGS='["gateway","run"]'

# Launch working directory if needed
VERVO_HERMES_CWD="/absolute/path/to/hermes/repo"

# Override the isolated Hermes profile/home
VERVO_HERMES_HOME="/absolute/path/to/hermes-home"

# Pin the Hermes API server URL instead of letting orchestrator choose a free local port
VERVO_HERMES_GATEWAY_URL="http://127.0.0.1:8642"

# Startup timeout
VERVO_HERMES_STARTUP_TIMEOUT_MS="45000"
```

## Repo

This repo is `huacamayo`. Vervo is the product.
