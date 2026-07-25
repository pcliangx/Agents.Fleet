# R0-04 — Claude Code + Codex Capability Probe

> Branch: `r0-04-agent-capability-probe`. Source of truth for R1 (Claude) / R2 (Codex) Adapter implementations.
> Facts gathered on 2026-07-25 from `claude --help` / `codex --help` and local `~/.claude` / `~/.codex` inspection (authentic transcript samples).

Both agents map cleanly onto `RT-ADAPTER-01..07`. **Key asymmetry:** Claude Code has a settings-level **Hook** system + a structured `stream-json` output mode; **Codex has no Hook system** — its status must be **inferred** from transcript/exec output. This drives each Adapter's `Hook` Capability (RT-ADAPTER-04: missing/failed Hook degrades to `inferred` Observation, never blocks the agent).

## Claude Code (`claude` 2.1.218)

- **Discovery:** `claude --version` → `2.1.218 (Claude Code)`; executable `~/.local/bin/claude`. Candidate discovery (pre-Trust) reads version/path only.
- **Permission mapping** (`--permission-mode <mode>`; transcript field `permissionMode`):
  | Requested | argv |
  |---|---|
  | Manual | `--permission-mode default` |
  | Balanced | `--permission-mode acceptEdits` |
  | YOLO | `--dangerously-skip-permissions` (or `--permission-mode bypassPermissions`) |
  - `--allow-dangerously-skip-permissions` enables bypass as a non-default option. `--allowedTools`/`--allowed-tools` further restrict.
- **Resume:** `-r, --resume <sessionId>` (by id); `-c, --continue` (most recent).
- **Observation channels:**
  1. `--print --output-format=stream-json` → structured streaming events (incl. tool calls) — primary real-time channel.
  2. Settings hooks (`PreToolUse`/`PostToolUse`/`SessionStart`/…) in `settings.json` → command/webhook. **Hook Capability = yes.**
  3. Transcript JSONL (below) — durable history.
- **Transcript:** `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, one file per session (UUID filename). JSONL events: `{type, sessionId, …}` — types include `agent-setting`, `mode`, `permission-mode` (`permissionMode` value), then messages (`parentUuid`, `isSidechain`, `teamName`, `agentName`, …). Encoded cwd = absolute path with `/` → `-`.
- **Tier:** **Full** (Discovery + Hook + Transcript + Resume + PermissionMapping).

## Codex CLI (`codex` 0.145.0)

- **Discovery:** `codex --version`; executable `~/.local/bin/codex`. Candidate discovery reads version/path only.
- **Permission mapping** (`-a,--ask-for-approval <policy>` + `-s,--sandbox <mode>`):
  | Requested | argv |
  |---|---|
  | Manual | `--ask-for-approval untrusted --sandbox read-only` |
  | Balanced | `--ask-for-approval on-request --sandbox workspace-write` |
  | YOLO | `--dangerously-bypass-approvals-and-sandbox` (or `--ask-for-approval never --sandbox danger-full-access`) |
  - Approval policies: `untrusted` / `on-request` / `never`. Sandbox modes: `read-only` / `workspace-write` / `danger-full-access`. `sandbox_permissions` via `-c`.
- **Resume:** `codex resume <sessionId|--last>`; also `codex exec resume`, `codex fork`. Session id = UUID.
- **Observation channels:** session rollout transcript (below) + `codex exec` output. **No settings-level Hook system** → status `inferred` from transcript/exec (RT-ADAPTER-04 path). MCP available via `codex mcp`/`mcp-server`.
- **Transcript:** `~/.codex/sessions/<year>/…` rollout JSONL; indexed by `~/.codex/session_index.jsonl`; `~/.codex/history.jsonl` (command history); `archived_sessions/` for archived.
- **Tier:** **Full** for Discovery/Transcript/Resume/PermissionMapping; **Hook Capability absent** (status inferred).

## Two-phase discovery (RT-ADAPTER-06)

- **Candidate (pre Active Trust):** both — `--version` + executable path only. No execution of agent/Git/shell/repo content.
- **Verified (post Active Trust, neutral cwd):** run the version probe + resolve the permission/transcript facts above into the Adapter's Capability + PermissionMapping. Actual agent process only starts at `CommitLaunch`.

## Fixture

Structured data: [`packages/testing/src/fixtures/agent-capabilities.ts`](../../packages/testing/src/fixtures/agent-capabilities.ts). R1/R2 Adapters verify against it.
