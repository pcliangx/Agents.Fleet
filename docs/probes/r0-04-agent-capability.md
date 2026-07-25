# R0-04 — Claude Code + Codex Capability Probe

> Branch: `r0-04-agent-capability-probe`. Source of truth for R1 (Claude) / R2 (Codex) Adapter implementations.
> Facts gathered 2026-07-25 from `claude --help` / `codex --help` + local `~/.claude` / `~/.codex` transcript samples.

Both agents map onto `RT-ADAPTER-01..07`. **Key asymmetry:** Claude Code has a settings-level **Hook** system + structured `stream-json` output; **Codex has no Hook system** → status **inferred** from transcript/exec (RT-ADAPTER-04: missing Hook degrades to `inferred` Observation, never blocks the agent).

The canonical per-mode permission data (Manual/Balanced/YOLO → `launchArgumentsPreview` + `effectiveMode` + enforced/unsupported/warnings) lives in the **fixture** — [`packages/testing/src/fixtures/agent-capabilities.ts`](../../packages/testing/src/fixtures/agent-capabilities.ts) — typed as the contracts `PermissionMapping` (SV1-PERM-05). This doc records the qualitative findings; it does not restate the structured values.

## Claude Code (`claude` 2.1.218)

- **Discovery:** executable `~/.local/bin/claude`. Candidate (pre-Trust) = install metadata + filesystem identity only (**no execution**). Verified (post-Trust) runs `claude --version` → `2.1.218 (Claude Code)` + resolves ExecutableIdentity / supportedVersionRange / Capability.
- **Permission:** `--permission-mode <mode>` (`default`/`acceptEdits`/`bypassPermissions`); `--dangerously-skip-permissions`; `--allow-dangerously-skip-permissions`; `--allowedTools`. Transcript field `permissionMode`. Per-mode argv in fixture.
- **Resume:** `-r, --resume <sessionId>` (by id); `-c, --continue` (most recent).
- **Observation:** (1) `--print --output-format=stream-json` structured events (primary real-time channel); (2) settings hooks `PreToolUse`/`PostToolUse`/… → command/webhook (**Hook Capability = yes**); (3) transcript JSONL (durable).
- **Transcript:** `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — one file per session (UUID filename). JSONL events `{type, sessionId, …}`.
- **Tier:** **Full**.

## Codex CLI (`codex` 0.145.0)

- **Discovery:** executable `~/.local/bin/codex`. Candidate (pre-Trust) = metadata + filesystem identity only (**no execution**). Verified (post-Trust) runs `codex --version` + resolves identity / Capability.
- **Permission:** `-a, --ask-for-approval <untrusted|on-request|never>` + `-s, --sandbox <read-only|workspace-write|danger-full-access>`; `--dangerously-bypass-approvals-and-sandbox`. Per-mode argv in fixture.
- **Resume:** `codex resume <sessionId|--last>`; `codex exec resume`; `codex fork`. Session id = UUID.
- **Observation:** session rollout transcript + `codex exec` output. **No settings-level Hook** → status inferred (RT-ADAPTER-04 path). MCP via `codex mcp` / `mcp-server`.
- **Transcript:** `~/.codex/sessions/<year>/…` rollout JSONL; indexed by `~/.codex/session_index.jsonl`; `~/.codex/history.jsonl`.
- **Tier:** **Full** for Discovery/Transcript/Resume/PermissionMapping; Hook absent.

## Two-phase discovery (RT-ADAPTER-06)

- **Candidate (pre Active Trust):** install metadata + filesystem identity only — **no execution** of agent/Git/shell/repo (ADR-0002 / CONTEXT.md `Repository Trust`).
- **Verified (post Active Trust, neutral cwd):** run `--version` + the capability/permission probe → resolve ExecutableIdentity, supportedVersionRange, Capability set, and PermissionMapping. The agent process only starts at `CommitLaunch`.

## Evidence basis (SV1-PERM-02)

`enforcedCapabilities` / `unsupportedControls` reflect only what `--help` proves. Controls whose **enforcement** is not proven by `--help` are listed in `unsupportedControls` with a `warnings` note to verify at R1/R2 runtime — never defaulted to safe. YOLO modes honestly enforce no boundary (by design): empty `unsupportedControls` + a "no boundary enforced" warning.
