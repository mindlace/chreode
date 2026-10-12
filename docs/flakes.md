# Flakes

A flaky test is a gate that is not deterministic: the same change gets a different verdict on a
re-run. Re-running is cheaper than fixing, so a suite that "usually passes" quietly stops
selecting anything. Flakes are bugs, not noise. This doc covers the machinery chreode provides
to make them visible and the playbook for killing them.

## The machinery

**Telemetry.** Run your test runners with at least one retry (`retries: 1` in Playwright, `retry: 1` in
vitest) and register chreode's reporters (see the README). Every test that fails and then
passes on a retry is appended to `.chreode/flakes.jsonl` with the first attempt's error and,
for Playwright, the local path of the failed attempt's trace (set `use: { trace: 'retain-on-failure' }`;
with `'on-first-retry'` only the passing retry is traced, so nothing is logged). A reporter only sees a retry when the runner
retries: with retries off there is nothing to record, and the reporters cannot tell that
retries are off. Turn them on. Keep pure-logic suites at zero retries; they must not flake
at all.

**The ledger.** With `flakes: {}` in `chreode.config.ts`, signoff reads the log after its steps,
whether they passed or failed, and gives each flaking test exactly one open GitHub issue
labelled `flake`, titled `flake(<kind>): <file> › <title>`. Each later run that sees the same
flake adds an occurrence comment. `chreode flake-report` does the same outside signoff, for
hosted CI or by hand. If a GitHub call fails, the events not yet recorded stay in the log for
the next run (those already recorded are not repeated); an outage never blocks a merge.

**Escalation.** At 3 recorded occurrences (`flakes.threshold`), any run that sees the flake
again fails until it is fixed. Escalations are listed with their issue URLs in the run's
failure output (signoff exits 1 and posts no commit status; `chreode flake-report` exits 1).
Labelling the issue `flake-snoozed` (`flakes.snoozeLabel`)
defers escalation. Like a stderr allowlist entry, a snooze is a reviewed decision, never a
reflex. A snoozed flake still runs and still records.

**Burn-in.** The `burn-in` step (`burnInStep({ when })`, with a `burnIn` config block naming how to run
each kind of test file) runs every test file added or changed on the
branch 5 times (`burnIn.repeats`) with retries off, up to 12 files (`burnIn.maxFiles`; the
overflow is listed, never silently dropped). Any failure fails signoff: a test that flakes at
birth flakes forever. Do not run repeat matrices by hand; signoff does it, the same way, every
time. A deflake change touches the test file, so it is burned in automatically.

## The playbook

Work the list top-down. It is ordered by how often each fix turned out to be the real one.

1. **Suspect a product bug first.** If the failure could happen to a slow human on a slow
   device, it is not a test bug. Typical shapes: a form binding re-seeded by a background
   refresh, a reactive draft that discards in-flight edits, a debounced handler that truncates
   submitted text.
2. **Add a deterministic readiness signal.** Assert on an explicit "ready" attribute (for
   example `data-hydrated` or `data-editor-ready`) instead of a poll budget or a fixed tick. If
   the app exposes no signal for the state you need, add one.
3. **Gate the precondition, not the result.** Poll until the precondition of the action is
   observably true before acting, rather than acting and polling for the outcome: result
   polling can settle on a wrong but stable state.
4. **Re-fire until observed**, for one-shot or throttled events (hover reveals, a first
   keypress) that can be missed under load with nothing re-firing them. Only for idempotent
   actions, and in a shared helper rather than an inline poll.
5. **Drive deferred work deterministically.** Timers, alarms and broadcasts have unbounded
   latency under full-suite CPU load: trigger the deferred work from the test instead of
   waiting wall-clock time. A fixture date that arms a real timer must never drift into the
   past, or the timer fires on its own before the test drives it.

**Never:** raise a timeout as the fix; add a fixed wait; write a wait helper that returns
instead of throwing on timeout (it hides the failure and spawns a worse flake later); leave a
flake to "just re-run".

**Scattered timeouts that never repeat the same test** are machine pressure (memory, swap,
stray processes), not test bugs. Check the machine first.

**A same-run cluster is one incident.** When several readiness timeouts from unrelated tests
are filed from one run at one sha, that is machine starvation wearing issue clothing. Before
diagnosing one, check its occurrence comments for same-run siblings. Keep one issue as the
ledger entry, close the rest as duplicates pointing at it, and never "fix" the cluster with
per-test timeout raises.

## Triaging a filed issue

1. Read the first-attempt error in the issue and open the trace at its local path (valid only
   until the next Playwright run wipes `test-results/`). Reproduce with the burn-in command
   shape: the runner's own command, the one file, retries off.
2. Diagnose with the playbook and fix it in a normal change. State the root cause when closing
   the issue: "re-ran it" is not a close reason.
3. If the fix must wait, label the issue `flake-snoozed` with a comment saying why and when it
   will be picked up. It keeps collecting occurrence comments.

## Root-cause classes

| Class                                                   | Fix                                           |
| ------------------------------------------------------- | --------------------------------------------- |
| One-shot or throttled event missed, nothing re-fires it | Re-fire until observed                        |
| Product bug unmasked by the test                        | Fix the product                               |
| Missing readiness gate                                  | Add a readiness signal                        |
| Layout or geometry not settled                          | Poll for a stable box before acting           |
| Timer or broadcast starvation                           | Drive the deferred work from the test         |
| Soft timeout masking a failure                          | Wait helpers must throw                       |
| Harness or transport not ready                          | Gate on backend readiness                     |
| Environment divergence (viewport, fonts, locale)        | Pin the environment; anchor deterministically |
| Same-run readiness cluster                              | Triage as one machine-starvation incident     |
| Fixture date drifted into the past                      | Relative fixture clocks                       |
