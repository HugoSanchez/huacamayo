# Composio Bridge

Thin remote bridge for Vervo's Composio-backed integrations.

## Purpose

- keeps the Composio project API key out of the desktop app
- lets `orchestrator` request Composio sessions and connection flows through a backend you control
- leaves user third-party credentials managed by Composio

## Environment

- `COMPOSIO_API_KEY`
  Required. Your Composio project API key.
- `VERVO_COMPOSIO_BRIDGE_TOKEN`
  Optional shared secret. If set, callers must send it as `X-Vervo-Bridge-Token`.
- `PORT`
  Optional listen port. Defaults to a random local port.

## Run

```sh
cd composio-bridge
COMPOSIO_API_KEY=your_key_here npm run serve
```

Or with a bridge token:

```sh
cd composio-bridge
COMPOSIO_API_KEY=your_key_here \
VERVO_COMPOSIO_BRIDGE_TOKEN=dev-shared-secret \
npm run serve
```

## Local orchestrator configuration

Point the macOS app sidecar at the bridge with:

- `VERVO_COMPOSIO_BRIDGE_URL`
- optional `VERVO_COMPOSIO_BRIDGE_TOKEN`

Example:

```sh
cd orchestrator
VERVO_COMPOSIO_BRIDGE_URL=http://127.0.0.1:8787 \
VERVO_COMPOSIO_BRIDGE_TOKEN=dev-shared-secret \
npm run dev
```

When `VERVO_COMPOSIO_BRIDGE_URL` is set:
- `orchestrator` uses the remote bridge for Composio session creation
- `orchestrator` uses the remote bridge for connection list/request/status
- the local app no longer needs `COMPOSIO_API_KEY`

## Endpoints

- `GET /health`
- `POST /v1/composio/session`
- `POST /v1/composio/session/reset`
- `GET /v1/connections?user_id=...`
- `POST /v1/connections/request`
- `GET /v1/connections/requests/:id`
