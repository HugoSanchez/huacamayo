#!/usr/bin/env bash
# Pinned inputs for the embedded runtimes. This file is sourced by both the
# local bundle builder and CI so release and verification cannot drift.

NODE_VERSION="24.15.0"
PBS_TAG="20260510"
PYTHON_VERSION="3.11.15"

HERMES_REPO="https://github.com/NousResearch/hermes-agent.git"
HERMES_REF="3ef6bbd201263d354fd83ec55b3c306ded2eb72a"
HERMES_EXTRAS="mcp,cli,cron"
HERMES_EXTRA_PINS=("aiohttp==3.13.3")

# Application order is part of the contract: request overrides build on the
# reasoning callback introduced by the first patch. Every .patch file in the
# directory must be listed here or verification fails.
HERMES_PATCHES=(
    "api-server-reasoning-stream.patch"
    "codex-tool-schema-required.patch"
    "verso-browser-guardrails.patch"
    "verso-cron-running-status.patch"
    "verso-gateway-mcp-oauth.patch"
    "verso-personal-assistant-prompts.patch"
    "verso-request-overrides.patch"
    "verso-tool-search-pinned.patch"
)
