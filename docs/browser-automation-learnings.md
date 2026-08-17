# Browser automation: findings and next steps

Date: 2026-08-17

Status: not shipping in Verso 1.0.20

Related work: PR #80

## Decision

Do not ship the local browser-routine implementation that was prototyped in
August 2026. It was unreliable for both public and authenticated tasks, could
repeatedly steal focus with headed browser windows, and could leave an
`agent-browser` daemon running after Verso or Hermes stopped.

Verso 1.0.20 removes the browser-specific UI, routes, runtime installer,
session plumbing, Hermes environment overrides, pinned MCP tool, and tests.
It retains the unrelated custom MCP work, the cron default-model repair, and
the general Hermes/sidecar lifecycle fixes discovered while debugging.

Existing pre-release browser jobs are preserved but paused by a one-time
managed-profile migration. Their definitions and run history remain available
for inspection or deletion, but they cannot silently resume after upgrade.

## What we tried

### 1. A Verso-owned browser connection layer

The first implementation treated websites like a new connector type and
introduced:

- a browser connection database;
- a dedicated Chrome/CDP launcher;
- per-routine browser sessions and leases;
- cron session tokens and domain scoping;
- a Hermes domain-guard patch;
- setup cards and browser-connection UI.

This duplicated capabilities already present in Hermes and `agent-browser`.
It also created two competing lifecycle and persistence models: one owned by
Verso and one owned by Hermes.

### 2. Hermes-native browser sessions with Verso login setup

We removed most of that first layer and tried a smaller integration:

- Hermes remained responsible for browser tools during cron runs;
- Verso installed a pinned `agent-browser` runtime on demand;
- Verso opened one headed Chrome window for interactive login;
- login state was saved under a stable `agent-browser` restore key;
- Hermes cron sessions loaded and saved that restore state;
- browser cron execution was serialized to avoid concurrent state writes.

This was architecturally smaller, but it did not make the end-to-end product
reliable enough to ship.

## What worked

- The browser setup card rendered after accounting for Hermes' MCP result
  envelope.
- The pinned browser CLI and Chrome runtime could install and launch.
- Raw navigation to a public page could succeed at the browser-command layer.
- The restore-state flow could save data and report that it had loaded it.
- Chrome profile inspection/import found Google cookies (52 in one test).
- The investigation produced useful general fixes: coalesced sidecar/Hermes
  shutdown and restart, correct child-exit detection, and better diagnostics.

These successes were component-level. They did not produce a dependable
scheduled user outcome.

## What failed in live testing

### Public, unauthenticated task

The Hacker News routine reached the site, but the agent then pursued an
irrelevant temporary-verification flow and returned no useful result. One run
used seven model calls with roughly 20,000 context tokens per call. This showed
that successful browser navigation is not the same as successful task
completion, and that open-ended browser control can become expensive before it
becomes visibly stuck.

### Authenticated task

The Google Docs routine remained signed out even after importing normal Chrome
state and copying 52 Google cookies into the automation state. Google redirected
the automation browser through sign-in and ultimately rejected or failed the
flow. Cookie count was therefore a misleading readiness signal: modern login
state can depend on profile-bound data, device trust, storage outside ordinary
cookies, provider risk checks, and browser identity.

### Interactive login UX

The sign-in modal sometimes appeared without a usable browser window. In other
runs, a browser window repeatedly activated every few seconds and interrupted
normal computer use. The UI polled login state frequently, and each state check
crossed process boundaries into browser commands. Multiple components could
attempt recovery or relaunch, so a transient failure became a foreground UX
failure.

### Process cleanup

After the app/Hermes lifecycle ended, an `agent-browser` daemon remained with
PPID 1, a live loopback listener, and a Verso namespace socket. It required an
explicit session close. This matches the failure class described by upstream
Hermes reports about browser-command timeouts and force-closed sessions leaving
daemons or Chromium trees behind.

### Observability

Cron outputs did not provide a trustworthy, complete explanation of what the
browser agent had done. Debugging required correlating Verso logs, Hermes logs,
cron job files, browser state, process lists, sockets, and screenshots. A
feature that can act autonomously needs a much better audit trail than this.

## Root-cause assessment

These are distinct problems; treating them as one bug led to repeated local
patches without improving the product outcome.

1. **Duplicated ownership.** Verso, Hermes, `agent-browser`, Chrome, and the
   cron scheduler each owned part of launch, state, recovery, or shutdown.
2. **Authentication fidelity.** Copying cookies is insufficient for providers
   such as Google and may trigger automated-browser or device-trust defenses.
3. **Agent reliability.** A general model with low-level browser tools can
   navigate successfully and still choose an irrelevant workflow.
4. **Unbounded cost and latency.** Repeated large-context model turns can spend
   substantial time and money without producing a user-visible result.
5. **Foreground side effects.** A scheduled feature must never repeatedly open
   or focus local windows; this implementation could.
6. **Weak auditability.** Missing or stale cron transcripts made it difficult
   to distinguish browser failure, model failure, and delivery failure.
7. **Upstream lifecycle defects.** Orphan cleanup was not reliable enough to
   delegate local resource safety to the current Hermes browser stack.

## Product rule going forward

Use integrations in this order:

1. a first-class MCP/Composio connector;
2. a direct API, RSS/feed, webhook, email, or file-based workflow;
3. a narrow website-specific adapter with deterministic parsing;
4. managed cloud browser automation as a last resort.

Do not add another Verso-owned local browser/session framework. If Hermes'
native browser support is reconsidered, upgrade it as an upstream dependency
and validate it against the same product-level acceptance suite; do not fork
its lifecycle inside Verso.

## Recommended next experiment: managed cloud browser tasks

Run this as a separate, time-boxed spike after the 1.0.20 release. Browser Use
Cloud is the leading candidate because its current APIs expose high-level
tasks/sessions, profiles, allowed domains, recordings, structured output,
maximum steps, and a session cost cap. Re-check the current API and pricing
before implementation.

The experiment should call one high-level remote task API. Verso should not
translate every browser action into a local model tool call, launch a local
Chrome instance, or own a CDP daemon.

Required controls:

- no local browser process or foreground window during a scheduled run;
- one isolated remote session per run;
- explicit allowed-domain list;
- hard maximum duration, steps, and cost per run;
- structured JSON output validated before delivery;
- recording, screenshots, step log, and final URL retained for audit;
- cancellation that demonstrably destroys the remote session;
- explicit confirmation before payment, messaging, deletion, or other
  consequential actions;
- idempotency keys or postcondition checks for every write action;
- secrets kept out of prompts and logs;
- authenticated profiles scoped per user and per provider;
- a global feature kill switch and per-job pause control.

### Time box

Limit the first spike to two engineering days and two test workflows. Do not
build production UI, migrations, or a generic connector abstraction during the
spike.

### Test workflows

1. **Public read-only:** fetch the top three Hacker News stories and return
   exact title/URL pairs in a JSON schema.
2. **Authenticated bounded write:** append one uniquely identified line to a
   dedicated test document, then read it back and prove exactly one append
   occurred.

### Go/no-go gates

- At least 19 of 20 consecutive public runs return schema-valid, factually
  correct results.
- At least 9 of 10 authenticated runs complete the exact test postcondition
  without duplicate writes.
- Cancellation, timeout, app quit, network loss, and machine sleep leave no
  local process and no active remote session.
- Every run has an inspectable recording/trace and an itemized cost.
- The measured per-run cost and latency fit budgets agreed before the spike.
- Authentication survives the intended profile lifetime without cookie-copy
  hacks or repeated interactive login.
- No test produces an unexpected domain visit or consequential action.

If any safety/lifecycle gate fails, stop. If only reliability or cost gates
fail, compare one alternative provider before deciding whether browser
automation belongs in the product at all.

## Relevant upstream references

- Hermes orphaned daemon/Chromium on browser timeout:
  https://github.com/NousResearch/hermes-agent/issues/68139
- Hermes cron transcript visibility/persistence failures:
  https://github.com/NousResearch/hermes-agent/issues/43121
- Additional `agent-browser` daemon accumulation report:
  https://github.com/NousResearch/hermes-agent/issues/13793
- Browser Use task API (v2):
  https://docs.browser-use.com/cloud/api-v2/tasks/create-task
- Browser Use session API (v3; includes profiles, structured output, and
  `maxCostUsd`):
  https://docs.browser-use.com/cloud/api-v3/sessions/create-session

## Release cleanup performed

- Paused the two local test routines (Hacker News and Google Docs).
- Closed and verified removal of the orphaned Verso `agent-browser` daemon.
- Removed all browser-only source files and generated UI references.
- Removed the browser login MCP tool and pin.
- Removed Verso's browser runtime PATH/executable/restore overrides from the
  Hermes child environment.
- Removed browser-only tests and runtime setup workarounds.
- Added a one-time migration that pauses active jobs whose
  `enabled_toolsets` contains `browser`, without deleting their definitions or
  history.
- Kept the generic serialized shutdown/restart fixes and their regression
  tests.
