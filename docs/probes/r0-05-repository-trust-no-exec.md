# R0-05 — Repository Trust No-Execution Boundary

> Branch: `R0-05`. Source of truth for the PendingValidation Git boundary used by R1+ Worktree Manager work.
> Facts gathered 2026-07-25 on macOS with `/usr/bin/git` = Apple Git 2.50.1. Executable evidence: `packages/daemon/src/__tests__/restricted-git.test.ts` (24 tests, hostile + corrupt fixtures included).

Deliverable: `packages/daemon/src/git/restricted-git.ts` — the **only** Git entry point allowed while Repository Trust is PendingValidation (RT-REPO-02 / SV1-FILE-06 / SV1-TRUST-04 / SV1-TRUST-08 / RT-ENV-01). Covers the Git half of SV1-T-01 and RT-T-29 / RT-T-36; the challenge/receipt flow (RT-REPO-06) and the no-external-program checkout (SV1-FILE-11, R0-11) are out of scope here.

## The boundary in one paragraph

- **Pre-Trust:** `readRepositoryCandidateMetadata` does `realpath` + `lstat` only. It has no process-spawning import at all — the no-execution rule is structural, not policy.
- **PendingValidation:** `RestrictedGitRunner.validateRepository` re-stats the candidate identity (fail closed on drift, zero Git calls), then runs a **frozen plan** of plumbing builtins with an explicit binary, structured argv (no shell), a scrubbed environment, and `-c` overrides that out-precedence every config-declared external program.
- **Classification:** `UnsupportedRepository` (bare / unborn-head / root-mismatch) and `RepositoryInvalid` (not-a-repository / corrupt / identity-drift / git-failed / git-timeout / output-unparseable), per RT-REPO-02. Detached HEAD imports with `currentBranch: null` (RT-REPO-04); linked worktrees resolve the common Repository identity via `--git-common-dir`; `defaultBaseRef` reports the clone-recorded `refs/remotes/origin/HEAD` target or `null` — never guessed (RT-REPO-04).

## Frozen plan (normal repo, 8 invocations)

`--version` (neutral cwd, evidence only) → `rev-parse --is-bare-repository` → `--show-toplevel` → `--absolute-git-dir` → `--git-common-dir` → `symbolic-ref -q HEAD` → `rev-parse --verify HEAD^{commit}` → `symbolic-ref -q refs/remotes/origin/HEAD` (+ one extra `rev-parse --verify` when origin/HEAD exists). Only on HEAD verify failure, one bounded `for-each-ref --format=%(refname)` runs as the unborn/corrupt discriminator.

## Why Repository config cannot redirect the plan

| Entry point declared by repo config | Can it execute during validation? | Mechanism |
| --- | --- | --- |
| `alias.rev-parse` / `alias.symbolic-ref` / `alias.for-each-ref` | **No** | Alias expansion only applies to commands git does not recognize as builtins; the frozen plan uses builtins only. Directly probed (test: "alias shadowing cannot redirect a plumbing builtin"). |
| `core.hooksPath` → hostile hooks | **No** | The plan never runs a hook-triggering command; `-c core.hooksPath=/dev/null` additionally neutralizes it. |
| `core.fsmonitor` hook | **No** | Plan never reads the index via a monitor-aware path; `-c core.fsmonitor=false`. |
| `core.pager` / `pager.*` | **No** | `--no-pager` global flag + `GIT_PAGER=cat` + `-c core.pager=cat`. |
| `core.editor` / `GIT_EDITOR` | **No** | Plan never opens an editor; env pinned to `/usr/bin/true`. |
| `diff.external`, `diff.<drv>.command`, `diff.<drv>.textconv` | **No** | Plan runs no diff; `-c diff.external=` unset. |
| `filter.<drv>.clean/smudge` | **No** | Filters only run on checkout/worktree materialization — the plan never touches the working tree. (Checkout-side no-external-program proof is SV1-FILE-11 / R0-11.) |
| `credential.helper` | **No** | Plan is local-refs only (SV1-FILE-07); `-c credential.helper=` reset + `GIT_TERMINAL_PROMPT=0`. |
| `core.sshCommand`, `url.*.insteadOf` | **No** | No network-capable command in the plan at all. |
| `include.path` → second hostile config | **No** | `-c` (command scope) has the highest config precedence — above system, global, repo, and included files. Fixture re-declares hooksPath/pager/alias via `include.path`; still nothing executes. |
| `submodule.recurse` | **No** | No recursive command in the plan; `-c submodule.recurse=false`. |
| Repository executables in the working tree | **No** | The plan never executes Repository files; fixture drops an executable `build.sh` in the tree and asserts silence. |
| Shell init files (`.zshrc` / `.bashrc` / …) | **No** | `execFile` spawns no shell, so nothing sources rc files; fixture points `HOME` at a hostile home with sentinel-writing rc files (RT-T-29). |

Ambient-environment attacks are scrubbed by constructing the child env from scratch (11-key allowlist): no `GIT_DIR` / `GIT_WORK_TREE` (would redirect discovery), no `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT` (would inject config), no `GIT_EXEC_PATH`, no `SSH_ASKPASS`, no `HOME` (system + global config neutralized via `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`). Test sets all of these hostile in `process.env` and validates cleanly.

## Corrupt vs unborn — probed discriminator

`rev-parse --verify HEAD^{commit}` prints the **same** `fatal: Needed a single revision` for an unborn branch and for a ref whose object is missing, so stderr alone cannot separate RT-REPO-02's "unborn / 无 commit" from "损坏". The runner's discriminator (probed on Apple Git 2.50.1):

- detached HEAD that does not resolve → **corrupt** (a detached HEAD is a raw SHA; if it doesn't resolve, the object is gone);
- otherwise one bounded `for-each-ref --format=%(refname)`: fatal (e.g. `missing object … for refs/heads/main`) → **corrupt**; empty output, or HEAD's target ref absent from the list → **unborn-head**; target present but still unresolvable → **corrupt**.

Other probed shapes: garbage `HEAD` content makes git itself refuse the directory (`not a git repository` → `not-a-repository`); a broken `.git/config` (`fatal: bad config line`) and missing/loose-object damage match a corrupt stderr signature (`bad config|missing object|bad object|bad ref|corrupt|loose object`) → `RepositoryInvalid/corrupt`; a symbolic HEAD pointing outside `refs/heads/` (e.g. at a tag) is rejected as **corrupt**, never reported as a branch name.

## Discovery policy

`GIT_CEILING_DIRECTORIES` was considered and **rejected**: pinning discovery to the candidate root makes a subdirectory-of-repo candidate indistinguishable from a non-repository (`not a git repository`), losing the RT-REPO-02 `root-mismatch` signal. Ascending discovery is read-only config access, and the exact `--show-toplevel == confirmed canonical root` check converts every over-ascent into a stable `UnsupportedRepository/root-mismatch`. No filesystem-boundary crossing occurs (git default).

## Git version

`rev-parse --absolute-git-dir` requires git ≥ 2.13 and `core.hooksPath` ≥ 2.9; the runner does **not** enforce a floor (that gate belongs to `SupportedPlatformMatrix`, R0-15) — on a pre-2.13 git the plan simply fails closed at step 3 with a stable `git-failed`/`corrupt` classification. The raw `git --version` string is recorded in every result as matrix evidence. Host probe: `/usr/bin/git` → `git version 2.50.1 (Apple Git-155)`.

## Failure-mode evidence (all in tests)

normal repo / detached HEAD / linked worktree / clone (origin/HEAD) import; bare, unborn (empty *and* other-refs-present), non-repo, root-mismatch rejection; corrupt fixtures for bad config, missing object (branch and detached), symbolic HEAD at a tag, garbage HEAD; identity drift rejected **before any Git invocation** (exec spy asserts zero calls); git timeout classified; exec audit asserts every call uses the explicit binary, `--no-pager`, the frozen command sequence, the 11-key env allowlist, and that the repo-independent `--version` runs from an app-owned neutral cwd (RT-ENV-02 shape).

## Non-guarantees / deferred

- Worktree **checkout** materialization (filters, smudge, submodule recursion) is a different, larger attack surface — SV1-FILE-11, probed in R0-11. This module never checks out.
- Trust challenge/receipt signing (RT-REPO-06), Workspace activation transaction (RT-REPO-03), Agent probes (post-Active only), and control-plane rejection of start / Workspace create pre-Trust (SV1-T-01's other half) are separate slices.
- RT-REPO-04's full per-ref SHA enumeration belongs to the Repository **inspection** slice, not validation; this module resolves SHAs only for the refs it reports (`HEAD`, `defaultBaseRef`).
- `FilesystemIdentity` is `dev + ino` from `lstat` — stable per mounted APFS volume; a remount/restore invalidates the binding, which is the intended fail-closed behavior (SV1-TRUST-03).
