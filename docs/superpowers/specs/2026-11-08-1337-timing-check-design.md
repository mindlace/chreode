# chreode timing check — design

Status: draft · 2026-11-08

## Why

`docs/flakes.md` says **never** add a fixed wait, raise a timeout as the fix, or leave a flake
to "just re-run". Today that is doctrine only. chreode catches flakes _after_ they exist:
telemetry, the ledger, and burn-in. Burn-in runs 5 times on an otherwise idle machine, so a
test that leans on wall-clock timing usually survives it and flakes weeks later under load.

The timing check enforces the doctrine at the moment the code is written. It reads the lines a
branch **adds** and fails signoff when they introduce a timing crutch. Because it looks only at
added lines, existing code never blocks a merge: the suite can only get better.

It complements lint rather than replacing it. Lint (for example eslint-plugin-playwright's
`no-wait-for-timeout`) bans syntax repo-wide. chreode knows the base, so it can see what lint
cannot: "this timeout went from 5s to 30s", "retries went from 1 to 3".

## Goals

- Fail signoff when a branch adds a fixed wait, raises a timeout, raises retries, or skips a test.
- Look at added lines only (a ratchet), so adopting it never requires cleaning up legacy code.
- Exempt performance tests, which legitimately measure time.
- Make every other exemption a reviewed, written decision, like `stderrAllowlist`.
- Be deterministic and fast: no test runs, no AST, just `git diff` and line matching.

## Non-goals

- Stressing the machine, throttling CPUs or running in parallel to expose timing bugs. This was
  explicitly rejected: it gets in the way of running more than one session at a time.
- Replacing lint, or banning patterns repo-wide.
- Parsing TypeScript. Line matching is good enough and can't be fooled by a broken build.
- Fixing anything automatically.

## Anti-goals

- **A check that cries wolf.** If honest code routinely needs an exemption, people learn to
  add exemptions by reflex, and the check is worse than nothing. Rules must be narrow.
- **A silent escape hatch.** No exemption may be invisible in review or in the signoff output.
- **Flaking itself.** Same inputs (base, head, config) must always give the same verdict.

## Shape

It mirrors burn-in.

- `chreode timing-check --base <sha> --head <sha>`: a CLI subcommand. It exits 1 and prints
  each violation (path:line, rule, the offending line, and a pointer to the playbook entry).
  It exits 0 and prints a one-line summary otherwise.
- `timingStep({ when, timeoutMs? })`: a config helper that returns a `StepConfig` with label
  `timing`. Like `burnInStep`, it skips when `base === head`. `when` takes the consumer's
  test-step triggers. stderr is policed.
- A `timing` config block. Its presence is not required for the step to work; defaults apply.

```ts
timing?: {
  /** Files the check reads. Default: common test-file and test-config globs (below). */
  match?: Matcher | Matcher[];
  /** Performance tests: never checked. Default: ['**/*.perf.*', '**/perf/**']. */
  perf?: Matcher | Matcher[];
  /** Rules to turn off, by id. */
  disable?: TimingRuleId[];
  /** Reviewed exemptions. */
  allow?: { path: Matcher | Matcher[]; rule: TimingRuleId; pattern?: RegExp; reason: string }[];
}
```

Default `match`: `**/*.{spec,test}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`, `**/e2e/**`,
`**/tests/**`, `**/test/**`, `**/{playwright,vitest,vite,jest}.config.*`, `**/vitest.workspace.*`.

## Reading the diff

**Range: the branch's own changes, not signoff's incremental base.** Signoff merges
`origin/<baseBranch>` first, so `<signoff base>..<head>` would include code other people already
merged to main, and the check would fail a branch for someone else's `waitForTimeout`. The check
therefore diffs `merge-base(head, origin/<baseBranch>)..head` (git's `origin/<baseBranch>...head`).
`chreode timing-check` takes `--head` (default `HEAD`) and reads `baseBranch` from the config
itself; there is no `--base`. Re-checking lines that an earlier signoff already passed is
harmless: the check is cheap and deterministic. _(Builder-check call.)_

`git diff --unified=0 --no-renames --diff-filter=AM <range> -- <matched paths>`, parsed into hunks
of removed and added lines with new-file line numbers. Deleted files are ignored. A renamed file
appears as added in full, which is the conservative choice. Files matching `perf` are dropped
before any rule runs. A `RegExp` matcher can't be a git pathspec, so filter paths after the diff
rather than in it.

**Net new, per hunk, for every rule.** With `--unified=0`, any edit to an existing line
(a Prettier rewrap, a rename) re-adds it. So each rule counts its matches among a hunk's removed
lines and among its added lines, and flags only the excess added matches (the last ones in the
hunk). Touching a legacy `waitForTimeout` without adding a new one is never flagged.
`timeout-raise` and `retries-raise` additionally compare values, as below. _(Builder-check call.)_

## Rules

Each rule has a stable id, used by `disable`, `allow` and the output.

| id              | Flags an added line that…                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fixed-wait`    | calls `waitForTimeout(`, awaits a `setTimeout` promise (`new Promise(… setTimeout(`), or calls a sleep or delay helper (`sleep(`, `delay(`, `wait(<number>)`). Calls under fake timers (`vi.advanceTimersByTime`, `clock.tick`, `page.clock.*`) are not flagged. |
| `timeout-raise` | sets a timeout (`timeout:`, `testTimeout:`, `hookTimeout:`, `actionTimeout:`, `navigationTimeout:`, `test.setTimeout(`, `test.slow(`, `{ timeout: N }` on `expect`/locators) to a value larger than the same key in this hunk's removed lines, or to any value when the hunk removes none. |
| `retries-raise` | sets `retries:`, `retry:` or `--retries=`/`--retry=` to a value larger than the removed one, or adds one where there was none.                                                                                    |
| `skip`          | adds an **unconditional** skip: `test.skip(`/`it.skip(`/`describe.skip(`/`test.fixme(` called with a title string (or no arguments), `test.describe.skip(`, `xit(`, `xdescribe(`. A conditional platform gate such as `test.skip(browserName === 'webkit', '…')` is honest gating, not a crutch, and is not flagged. _(Builder-check call.)_ |

Comparing within a hunk keeps "lowered a timeout from 30s to 5s" and "moved a line" from being
flagged. Numeric literals with `_` separators and simple `N * 1000` products are evaluated; any
other expression (a variable, a function call) on a raised-timeout key is flagged, since chreode
cannot tell whether it went up.

## Exemptions

- **Performance tests** are exempt wholesale, by path (`timing.perf`). The path convention is
  visible in review and in the file tree; a title tag would let any test opt out by renaming.
- **Everything else** goes through `timing.allow`, with a required `reason`, in
  `chreode.config.ts`. Editing that file is itself a reviewed change. An allow entry matches a
  violation when its path matches, its rule matches, and its `pattern` (if any) matches the line.
- Each exemption used is printed in the output, with its reason, even on success.
- There are no inline `// chreode-allow` comments: they are easy to add by reflex and hard to
  audit.

## Output

```
[chreode] timing: 2 violations in 1 file
  e2e/editor.spec.ts:42  fixed-wait     await page.waitForTimeout(500);
  e2e/editor.spec.ts:57  timeout-raise  test.setTimeout(60_000);  (was 30_000)
  Fix: docs/flakes.md#the-playbook — add a readiness signal or drive the deferred work.
  Exempt only with a reviewed timing.allow entry in chreode.config.ts.
```

## Constraints

- Pure planning core, git at the edges: diff parsing and rule evaluation are pure functions over
  strings, tested without git; one module calls `git diff` through the injectable `Exec`.
- No new runtime dependencies.
- Config validation follows `validate.ts`'s existing style: unknown rule ids in `disable`/`allow`
  are errors; `allow` entries without a non-empty `reason` are errors.
- `docs/flakes.md` gains a short "The timing check" section under _The machinery_; the README
  documents `timingStep` and the `timing` block next to burn-in.
- chreode adopts it in its own `chreode.config.ts`. The rule specs necessarily contain the
  banned text as string fixtures, so chreode's config carries `timing.allow` entries scoped to
  `src/timing/**/*.spec.ts` (no `pattern`), with the reason "rule fixtures: banned text as
  data". This is the intended use of `allow`: honest, narrow and written down.
  _(Builder-check call.)_

## Left to the builder

- The exact regexes, provided the rule table's intent holds and each has positive and negative
  spec cases (including fake-timer calls that must not be flagged).
- Module layout under `src/timing/`.
- Whether `fixed-wait`'s helper-name list (`sleep`, `delay`, `wait`) is configurable; not
  required.
