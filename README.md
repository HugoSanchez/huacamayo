# Vervo

A native macOS app for AI-powered research. Create research contexts from your local documents, build a knowledge graph that connects ideas across papers, and chat with your research using a local AI agent.

## Architecture

- **Vervo/** -- SwiftUI macOS app (UI, onboarding, context management, chat)
- **research-core/** -- Bun sidecar service (indexing, retrieval, knowledge graph, MCP server). Derived from [gbrain](https://github.com/garrytan/gbrain), adapted for local-first research with GGUF models.

## Development

```sh
# Open the macOS app in Xcode
open Vervo.xcodeproj

# Run the research-core sidecar
cd research-core && bun install && bun run dev
```

## Repo

This repo is `huacamayo`. Vervo is the product.
