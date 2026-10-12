# chreode core — design

Status: draft for discussion · 2026-10-11

## Why this exists

A _chreode_ (Waddington) is the canalized valley a developing system rolls
down: perturb it and it returns to the path, because the landscape is shaped
to select for it. Carcinization is the same idea seen from the outside —
independent lineages converging on the same form because the selective
pressure is consistent.

Agent-written software needs both. An agent will produce _something_ for any
prompt; whether the codebase drifts toward the shape you want depends on
whether the feedback it receives is **deterministic, selective, and
unavoidable**:

- **Deterministic** — the same change gets the same verdict, every time, on
  any machine. No "it passed when I re-ran it".
- **Selective** — the feedback discriminates: a change that weakens the
  codebase fails, and says why, in terms the agent can act on.
- **Unavoidable** — the agent cannot route around it: no wrapping the gate in
  `| tail`, no running a hand-picked subset and calling it green, no merging
  without the gate's status.

chreode packages a working implementation of that landscape, extracted from a
production codebase where agents write most of the code. It is a set of
layers; the **gate** (`chreode signoff`) is the terminal one, and it is only as
good as the layers feeding it (lint rules, e2e coverage, visual checks, the
guardrail hooks). This spec covers the core — the gate and its plumbing — and
names the later layers so the structure has room for them.

The README opens with this section; it is also the pitch.

## Scope

**v0.1 (this spec):**

1. `chreode signoff` — the incremental, machine-serialized local-CI gate that
   pushes the branch and posts a required GitHub commit status.
2. `chreode protect` — idempotently applies branch protection requiring that
   status.
3. `chreode.config.ts` — the per-repo config both commands read.
4. sfhousing adopts it, replacing its hand-ported `scripts/signoff.ts`.

**Later layers (named, not designed here):** `chreode precommit` (the
cheapest-first fix loop over changed paths), guardrail hooks for Claude Code
(deny wrapped/backgrounded signoff, redirect ad-hoc validation to sanctioned
entrypoints, deny repo-wide lint passes) generated from the same config, the
visual-check skill, a flake ledger (flaky tests → tracked GitHub issues with
escalation), burn-in of changed tests, and a test-doctrine doc. Hooks and
skills likely ship as a Claude Code plugin alongside the npm package.

**Non-goals:** remote/multi-machine execution (deliberately removed upstream);
non-GitHub forges; replacing hosted CI (hosted CI stays as contributor
feedback; the local status is the merge gate).

## The model

```
change ──► changed paths ──► triggers ──► planned steps ──► run (serialized, policed) ──► push ─► status ─► note
            (since last        (rules,        (steps whose                                          (merge gate)
             signoff)          first match)    triggers fired)
```

- **Incremental by construction.** The last successful signoff on a branch is
  recorded as a git note on its HEAD (`refs/notes/chreode`). The next run diffs
  from that commit (or from the merge-base with the base branch if none), so
  re-signing after a docs fix runs the docs steps, not the e2e suite.
  `--full` overrides.
- **Unknown paths run everything.** A changed path no rule matches fires every
  trigger. Rules can only make runs _smaller_ by matching; forgetting a rule
  costs time, never coverage.
- **Machine-serialized.** Steps hold gigabytes; several agents in parallel
  worktrees running the suite at once swap the machine to death and produce
  spurious failures. One machine-global lock (shared across _all_ repos using
  chreode, since the contended resource is the machine) serializes runs; a
  waiter logs once and polls. Stale locks from crashed holders are stolen.
- **Stderr is a failure signal.** For policed steps, stderr is captured; a
  step that exits 0 but wrote non-allowlisted stderr fails. A "passing" test
  that logs errors is a failure. Allowlisting is a reviewed config change with
  a recorded reason.
- **Merge main first.** The branch is merged with `origin/<base>` before
  testing, so what is signed off is what will land. A conflict exits non-zero
  and leaves the merge in progress.
- **The status is the product.** On success: push, post
  `<statusContext>` = success on HEAD with a description naming the signer and
  any skipped steps, then write the note (a failed post must not leave a note
  that makes the next run report "already signed off" with no status on GitHub). Branch protection requires that context.

## Config

`chreode.config.ts` at the repo root, loaded with `jiti` (no build step in the
consumer, works on any supported Node). `defineConfig` is an identity helper
for types.

```ts
import { defineConfig } from 'chreode';

export default defineConfig({
  baseBranch: 'main', // default
  statusContext: 'chreode/signoff', // default

  // First match wins. `match`: glob (picomatch) or RegExp, or an array of them.
  // `triggers: []` means "matched, nothing to run" (e.g. docs that need nothing).
  rules: [
    { match: ['docs/**', '**/*.md'], triggers: ['format'] },
    { match: 'src/**', triggers: ['lint', 'check', 'unit', 'e2e'] },
    { match: 'e2e/**', triggers: ['lint', 'e2e'] },
    { match: '.github/workflows/**', triggers: ['workflows'] }
  ],

  // Ordered. A step is planned when any of its `when` triggers fired.
  steps: [
    { label: 'format', run: 'npx prettier --check .', when: ['format'], supersededBy: ['lint'] },
    { label: 'lint', run: 'npm run lint', when: ['lint'] },
    { label: 'check', run: 'npm run check', when: ['check'] },
    { label: 'test:unit', run: 'npm run test:unit', when: ['unit'], policeStderr: true },
    {
      label: 'test:e2e',
      run: 'npm run test:e2e',
      when: ['e2e'],
      policeStderr: true,
      timeoutMs: 15 * 60_000
    },
    { label: 'lint:workflows', run: 'actionlint', when: ['workflows'] }
  ],

  afterMerge: 'npm install', // runs only when the merge actually changed the branch

  stderrAllowlist: [{ pattern: /^\[WebServer\] /, reason: 'Playwright echoes the preview server' }]
});
```

Step fields:

| Field          | Type                                     | Meaning                                                                                       |
| -------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `label`        | string                                   | Unique; used by `--skip`, the note, the status description.                                   |
| `run`          | `string \| (ctx) => string`              | Shell command. The function form gets `{ base, head, paths, triggers, isWorktree }`.          |
| `when`         | string[]                                 | Fires if any listed trigger fired.                                                            |
| `if`           | `(ctx) => boolean`                       | Extra predicate (e.g. "only in a worktree").                                                  |
| `supersededBy` | string[]                                 | Dropped when any listed step label is also planned (prettier-only vs. full lint).             |
| `policeStderr` | boolean                                  | Capture stderr and fail on non-allowlisted lines.                                             |
| `timeoutMs`    | number                                   | Hard wall-clock ceiling; the step's process group is SIGKILLed past it. Default 10 min.       |

`run` as a function plus `if` cover what upstream does with hard-coded
splices (prime the worktree before e2e; burn-in after the last test step with
`--base/--head`; flake-report after tests) — they become ordinary ordered
steps. Triggers are free-form strings; chreode attaches no meaning to them.

Config is validated at load: unknown keys, duplicate labels, and a
`supersededBy` naming a nonexistent label are errors. A `when` trigger that no
rule emits is allowed — the unknown-path fallback can still fire it.

## `chreode signoff`

Flags (each also settable by env, for agents whose harness forbids flags
after `--`): `--full` / `CHREODE_FULL=1`, `--dry-run`, `--no-merge` /
`CHREODE_NO_MERGE=1`, `--no-push` / `CHREODE_NO_PUSH=1`, `--allow-stderr` /
`CHREODE_ALLOW_STDERR=1`, `--base <ref>`, `--skip <label>` (repeatable), `--config <path>`.

Flow:

1. **Preconditions** — clean working tree; `gh auth status` ok; branch not
   behind its upstream; not on `baseBranch` itself.
2. **Merge** `origin/<baseBranch>` unless `--no-merge`; on a real merge run
   `afterMerge`.
3. **Resolve base** — `--base`, else the nearest ancestor carrying a
   `refs/notes/chreode` note, else the merge-base with `origin/<baseBranch>`.
   If base == HEAD: "already signed off", exit 0.
4. **Plan** — changed paths → triggers (rules, unknown → all) → steps
   (`when`, `if`, `supersededBy`, `--skip`). Print base/head, changed paths,
   plan, and each skipped step with its reason. `--dry-run` stops here.
5. **Run** — acquire the machine lock; run steps in order via the step runner
   (own process group, timeout, stderr capture for policed steps); export
   `CHREODE_SIGNOFF=1` to children so tools can quiet themselves under the
   gate. First failure releases the lock and exits 1. An empty plan touches no
   lock.
6. **Tail** — `git push -u origin HEAD` (unless `--no-push`); post the status; write
   the note (the labels that ran, or `no-op`) only after the post succeeds; print the PR URL if one
   exists.

Exit codes: 0 success / already signed off / dry-run; 1 step failure,
precondition failure, merge conflict, or lock wait timeout.

## `chreode protect`

Applies (idempotently, `gh api PUT …/branches/<base>/protection`) a policy
requiring `statusContext` with `strict: true`. Defaults match sfhousing's
current script: enforce admins, linear history, PR required with 0 approvals,
dismiss stale reviews; plus repo merge settings (squash only, delete head
branches). Overridable under `protection:` in config. `--dry-run` prints the
payloads.

## Package shape

- Repo `github.com/mindlace/chreode` (public), local at
  `~/Projects/chreode`. MIT, TypeScript (ESM, strict), Node ≥ 22.12. Package
  `@mindlace/chreode`, compiled to `dist/` (consumers need no `tsx`). Bin:
  `chreode`.
- Dependencies: `commander`, `proper-lockfile`, `jiti`, `picomatch`. Runtime
  requirements: `git`, `gh` (authenticated).
- Modules (lifted from upstream where noted, upstream is ~1,200 LOC):
  `config/` (types, `defineConfig`, loader, validation — new),
  `git/change-set.ts`, `git/merge.ts`, `lock/machine-lock.ts`,
  `run/step.ts` (process group + timeout + capture), `run/stderr.ts` (policing),
  `signoff/plan.ts` (rules → triggers → steps, pure), `signoff/run.ts`
  (orchestration), `signoff/tail.ts`, `github/status.ts`, `github/protect.ts`,
  `cli.ts`.
- chreode gates itself: its own `chreode.config.ts`, and `chreode protect` on
  its own `main` (requiring `chreode/signoff`) once the gate works — the
  bootstrap PR is the last one merged without it. The gate runs from the
  checkout's own build (`node dist/cli.js`), not a published version.

## Testing

- **Unit (vitest)** for every pure piece: rule matching and first-match-wins,
  unknown-path fallback, step planning (`when`/`if`/`supersededBy`/`--skip`),
  stderr policing (exit vs. stderr outcomes, ANSI stripping, allowlist),
  status description (140-char cap), config validation, lock retry/steal with
  injected I/O, and lock release when a step fails.
- **Integration**: drive `chreode signoff` end-to-end against a throwaway git
  repo with a bare `origin` and a `gh` shim on `PATH` that records calls.
  Covers: first signoff runs the full plan; a second signoff after a docs-only
  commit runs only the docs steps; a failing step posts nothing; `--no-push`;
  merge-conflict exit; "already signed off".
- Test discipline: no change-detector tests; one behavior, one home.

## First consumer: sfhousing

sfhousing already gates merges on `local-ci/signoff` (branch protection is
live) via a hand-ported, non-incremental `scripts/signoff.ts` that runs check,
lint, unit and e2e on every run. It moves to the `chreode/signoff` context.
Adoption PR in sfhousing:

- Add `@mindlace/chreode` as a devDependency; add `chreode.config.ts` with
  rules for `src/`, `e2e/`, `scripts/`, docs/markdown, workflows, and steps
  `lint`, `check`, `test:unit`, `test:e2e`, `lint:workflows` (exact rules
  drafted against sfhousing's tree in the implementation plan — anything
  unmatched, e.g. the data pipeline, falls through to "run everything").
- `package.json`: `"signoff": "chreode signoff"`, `"branch-protection":
  "chreode protect"`; delete `scripts/signoff.ts`, its spec,
  `scripts/branch-protection.ts`, and `scripts/gh-repo.ts` if nothing else
  uses it.
- `.github/workflows/release-please.yml` posts the status on the release PR
  head; its context changes from `local-ci/signoff` to `chreode/signoff`.
- Update `CLAUDE.md` / `docs/dev/deploy.md` to the new context and command.
- **Context switch-over, in order:** sign off the adoption branch with chreode
  (posts `chreode/signoff`); run `chreode protect` (main now requires
  `chreode/signoff` instead of `local-ci/signoff`); merge. Every open sfhousing
  PR then needs a re-signoff under chreode after merging main.
- Drop the in-flight branch `feat/signoff-docs-fast-path` and its worktree —
  incremental planning subsumes it (user-approved). Check it for unpushed
  work worth keeping first.

## Distribution

Public npm, `@mindlace/chreode`, MIT. `.github/workflows/publish.yml`
publishes on a `v*` tag via npm trusted publishing (OIDC, `id-token: write`,
provenance automatic for a public repo; `prepack` builds `dist/`). npm only
lets a trusted publisher be attached to a package that already exists, so
**v0.1.0 is published by hand by the user** (`npm login`, `npm publish
--access public`), after which they attach the trusted publisher
(`mindlace/chreode`, workflow `publish.yml`) in the npm package settings;
later versions publish from tags. sfhousing then installs it like any other
dependency — no registry mapping or tokens.

## The upstream codebase (later)

The codebase chreode was extracted from migrates in its own follow-up: its
burn-in, flake-report and worktree priming become ordinary config steps, its
stderr allowlist moves to config, and its private lock is replaced by
chreode's machine lock. Its existing signoff notes are not migrated — the
first chreode run there is a full run.

## Decisions

- Default status context `chreode/signoff`; sfhousing switches to it.
- Package `@mindlace/chreode`; bin `chreode`.
- GitHub repo public; MIT.
- Registry: public npm (see Distribution).
- One machine-global lock across all chreode repos (the contended resource is
  the machine, not the repo).
