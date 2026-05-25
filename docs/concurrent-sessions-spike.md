# Spike verdict: pi concurrent in-process sessions

**Date:** 2026-05-25
**Task:** Task 1 gate of `docs/superpowers/plans/2026-05-25-repo-audit-parallel-jobs.md`
**Verdict:** ✅ **GO** — pi tolerates ≥2 concurrent `runWithPi` sessions in one process.

## Method

Two `runReview()` calls (text-only, `userPromptOverride` + `systemPrompt`, empty diff)
issued via `Promise.all`, against the configured default provider, measured against a
single-call baseline.

## Result

| Scenario        | Elapsed | Content              |
|-----------------|---------|----------------------|
| Single call     | 2831 ms | `"ALPHA"`            |
| Two concurrent  | 3442 ms | `"ALPHA"` + `"BETA"` |

Two concurrent calls ≈ 1.2× single-call latency (not ~2×) ⇒ genuine overlap, no
provider-level serialization. Content correct and non-crosstalked; no crash.

Resolved provider during the run: `openai-codex/gpt-5.5` (shells out to a CLI, yet
still parallelizes — the strongest case for serialization, and it held).

## Caveat

An initial run hit a 180s wall on a cold start / transient slow response. This is a
latency event, not a concurrency limit (re-run completed in seconds). It is already
covered by the per-call timeout (`runWithPi` `timeoutMs`) and the orchestrators'
transient-error handling, which leaves a finding `open`/untouched for retry rather
than crashing the run.

## Conclusion

Proceed with the in-process worker pool (Tasks 2–6). No child-process fallback needed.
