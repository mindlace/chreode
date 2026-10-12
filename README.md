# chreode

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

## Install

```bash
npm install --save-dev @mindlace/chreode
```

Requires Node ≥ 22.12, `git`, and an authenticated [`gh`](https://cli.github.com/).

## Usage

Add `chreode.config.ts` at the repo root (see below), then:

```bash
npx chreode signoff            # merge origin/main, run what changed, push, post the status
npx chreode signoff --dry-run  # merge, then print the plan and stop
npx chreode protect            # require the status on main (idempotent); --dry-run previews
```

Wire them into `package.json` as `"signoff": "chreode signoff"` and
`"branch-protection": "chreode protect"`. Run signoff instead of pushing: it pushes for you.

### `chreode signoff`

1. **Preconditions**: clean tree, a branch (not detached, not the base branch), not behind its
   upstream, `gh auth status` ok, `git config user.email` set.
2. **Merge** `origin/<baseBranch>` (unless `--no-merge`). A conflict exits 1 and leaves the
   merge in progress. When the merge changed the branch, `afterMerge` runs and the config is
   reloaded, so a merged-in `chreode.config.ts` governs the rest of the run.
3. **Base**: `--base`, else the nearest commit on the branch carrying a `refs/notes/chreode`
   note (the last successful signoff), else the merge-base with `origin/<baseBranch>`.
4. **Plan**: changed paths (both sides of renames, deletions included) → triggers (first
   matching rule; a path no rule matches fires every trigger) → steps (`when`, `if`,
   `--skip`, `supersededBy`). The plan and every skipped step's reason are printed.
5. **Run** the steps in order under one machine-wide lock shared by every chreode repo on the
   machine. Each step runs in its own process group with a hard timeout; policed steps fail
   on unexpected stderr. Children see `CHREODE_SIGNOFF=1`.
6. **Tail**: refuse if the steps changed the checkout; push; post `<statusContext>` = success
   naming the signer and disclosing any `--skip`'d steps, stderr waived by `--allow-stderr`,
   and `base=<ref>` for `--base`; write the note. A partial run (any of those three) writes
   no note, so it never becomes the incremental base: the next signoff diffs from the last
   full one and re-plans what was skipped.

| Flag              | Env                      | Effect                                                                                                                       |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `--full`          | `CHREODE_FULL=1`         | Ignore the incremental base; run every step                                                                                  |
| `--dry-run`       |                          | Merge and run `afterMerge`, then print the plan and stop without running steps; add `--no-merge` for a side-effect-free look |
| `--no-merge`      | `CHREODE_NO_MERGE=1`     | Do not merge `origin/<baseBranch>` first                                                                                     |
| `--no-push`       | `CHREODE_NO_PUSH=1`      | Do not push (the commit must already be on origin)                                                                           |
| `--allow-stderr`  | `CHREODE_ALLOW_STDERR=1` | Downgrade policed stderr to a warning (named in the status; no note)                                                         |
| `--base <ref>`    |                          | Diff from this ref (named in the status; no note)                                                                            |
| `--skip <label>`  |                          | Skip a planned step (repeatable; named in the status; no note)                                                               |
| `--config <path>` |                          | Config file (default `<repo root>/chreode.config.ts`)                                                                        |

Exit codes: `0` signed off, already signed off, or dry run; `1` anything else.

The lock lives at `$TMPDIR/chreode-signoff.lock`. A waiter logs once and polls for up to an
hour; a lock whose holder died goes stale after 30 s and is stolen. `CHREODE_LOCK_PATH`
overrides the path (for test isolation only).

### `chreode protect`

`PUT`s branch protection on `<baseBranch>` requiring `<statusContext>` (strict), with admins
enforced, linear history, PRs required (0 approvals, stale reviews dismissed), and `PATCH`es
the repo to squash-only merges that delete head branches. Override either payload under
`protection` in the config. `--repo owner/name` targets another repo; `--dry-run` prints the
payloads.

## Config reference

```ts
import { defineConfig } from '@mindlace/chreode';

export default defineConfig({
  baseBranch: 'main', // default
  statusContext: 'chreode/signoff', // default
  rules: [
    { match: ['docs/**', '**/*.md'], triggers: ['format'] },
    { match: 'src/**', triggers: ['lint', 'check', 'unit', 'e2e'] },
    { match: 'generated/**', triggers: [] } // matched, nothing to run
  ],
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
    }
  ],
  afterMerge: 'npm ci', // not `npm install`: see below
  stderrAllowlist: [{ pattern: /^\[WebServer\] /, reason: 'Playwright echoes the preview server' }]
});
```

**Rules** are tried in order; the first whose `match` (a [picomatch](https://github.com/micromatch/picomatch)
glob, dotfiles included, or a RegExp, or an array of them) matches a changed path decides its
triggers. A path no rule matches fires every trigger: rules can only make runs smaller, so a
forgotten rule costs time, never coverage. Triggers are free-form strings.

**Steps** run in config order.

| Field          | Type                        | Meaning                                                                |
| -------------- | --------------------------- | ---------------------------------------------------------------------- |
| `label`        | string                      | Unique, no whitespace. Used by `--skip`, the note and the status.      |
| `run`          | `string \| (ctx) => string` | Shell command. `ctx` is `{ base, head, paths, triggers, isWorktree }`. |
| `when`         | string[]                    | Planned if any listed trigger fired.                                   |
| `if`           | `(ctx) => boolean`          | Extra predicate, e.g. only in a worktree.                              |
| `supersededBy` | string[]                    | Dropped when any listed step will also run.                            |
| `policeStderr` | boolean                     | Fail a clean exit that wrote non-allowlisted stderr.                   |
| `timeoutMs`    | number                      | Hard ceiling; default 10 minutes.                                      |

**`afterMerge`** runs only when merging `origin/<baseBranch>` changed the branch. It must
leave the checkout clean (signoff refuses to run otherwise), so use `npm ci`, which installs
exactly the lockfile, rather than `npm install`, which can rewrite it.
**`stderrAllowlist`** entries need a `reason`: allowlisting noise is a reviewed decision.
Unknown keys, duplicate labels, and `supersededBy` naming a missing step are load errors.

## License

MIT
