---
description: Run AI-powered code review on the current repo via the kode-review CLI
argument-hint: [pr [N] | repo | local | both | findings [open|critical|...] | --reviewer NAME | --with-context | ...]
---

# /kode-review

Run a code review using the local `kode-review` CLI binary, then summarize the findings inline.

User arguments: `$ARGUMENTS`

## Step 1 — Preflight

Run:

```bash
command -v kode-review >/dev/null || { echo "MISSING"; exit 0; }
```

If the binary is missing, tell the user:

> `kode-review` is not on PATH. Install with `npm i -g @ebernie/kode-review-cli` (or `bun add -g @ebernie/kode-review-cli`), then run `kode-review --setup`.

Stop here.

## Step 2 — Parse `$ARGUMENTS`

Decide the scope from the first token:

| First token | Action |
|-------------|--------|
| `pr` | `--scope pr`. If the next token is a number, add `--pr <N>`. |
| `repo` | `--scope repo` — **warn the user this can take a while** (whole-codebase audit, multiple model calls) and confirm before running |
| `findings` | `--list-findings` — see the **Listing persisted findings** section below; no model call, no scope detection |
| `local` | `--scope local` |
| `both` | `--scope both` |
| `watch` | `--watch` — tell the user this is long-running and confirm before launching |
| `--*` | No scope; pass everything through verbatim and let the CLI's `--scope auto` decide |
| *(empty)* | Smart-detect (Step 3) |

Always carry any remaining flag-style tokens (`--reviewer security`, `--with-context`, `--post-to-pr`, `--model X`, etc.) through to the invocation.

## Step 3 — Smart-detect scope (only when no scope token given)

Guard the git state first — bail with a clear message if any of these fail:

```bash
# Not in a git repo?
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "NOT_A_REPO"; exit 0; }

# Detached HEAD? — can't smart-detect; ask user for explicit scope.
git symbolic-ref -q HEAD >/dev/null || { echo "DETACHED"; exit 0; }
```

If `NOT_A_REPO` → "Not inside a git working tree — run `/kode-review` from a repo, or pass an explicit scope." Stop.
If `DETACHED` → "On a detached HEAD — smart-detect can't infer a base. Re-run with an explicit scope: `/kode-review local`, `/kode-review pr <N>`, or `/kode-review repo`." Stop.

Then probe state. Note `@{u}` requires a tracked upstream; fall back to `origin/HEAD` when missing:

```bash
UNCOMMITTED=$(git status --porcelain 2>/dev/null | head -c1)
if git rev-parse --abbrev-ref @{u} >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)
elif git rev-parse origin/HEAD >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count origin/HEAD..HEAD 2>/dev/null || echo 0)
else
  AHEAD=0  # no remote to compare against — local-only review path
fi
```

| Signal | Scope |
|--------|-------|
| `UNCOMMITTED` non-empty AND `AHEAD > 0` | `--scope both` |
| `UNCOMMITTED` non-empty only | `--scope local` |
| `AHEAD > 0` only | `--scope pr` |
| Neither | Reply "Nothing to review — clean tree, no commits ahead of base." and stop. |

State which scope you picked and why in one sentence before invoking. If `@{u}` was missing and you fell back to `origin/HEAD`, mention that.

## Step 4 — Invoke

```bash
# Use mktemp: predictable timestamps in $TMPDIR allow a co-resident local
# user to pre-create symlinks at the expected path. mktemp creates the file
# atomically with a random suffix and ensures unique names per invocation.
TMPDIR="${TMPDIR:-/tmp}"
OUT=$(mktemp "$TMPDIR/kode-review.XXXXXX.json") || exit 1
ERR=$(mktemp "$TMPDIR/kode-review.XXXXXX.err") || exit 1
kode-review \
  --format json \
  --output-file "$OUT" \
  --quiet \
  <scope flags> <passthrough flags> \
  2> "$ERR"
RC=$?
```

Notes:

- `--quiet` suppresses stdout, so the JSON only lands in `$OUT`. Don't omit `--output-file`.
- If `RC != 0`, `cat "$ERR"` and surface the error verbatim to the user. Stop.

## Step 5 — Parse and summarize

Read `$OUT`. It has this shape:

```json
{
  "summary": "...",
  "issues": [
    { "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "...", "title": "...",
      "file": "src/x.ts", "line": 42,
      "description": "...", "suggestion": "...", "confidence": "..." }
  ],
  "issueCount": { "critical": N, "high": N, "medium": N, "low": N },
  "positives": ["..."],
  "verdict": { "recommendation": "APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION",
               "mergeDecision": "SAFE_TO_MERGE|DO_NOT_MERGE|CONDITIONAL_MERGE",
               "rationale": "..." },
  "metadata": { "scope": "...", "model": "...", ... }
}
```

### If `parseError: true`

The CLI couldn't parse the model's response into structured findings. Emit ONLY this — no header line, no counts, no findings table:

```
kode-review: structured parsing failed — see raw output in $OUT
```

Then stop. Do NOT fabricate counts or findings.

### Normal path

```
kode-review (<scope>, <model>): <total> findings (<C> CRITICAL, <H> HIGH, <M> MED, <L> LOW)

<top 5 issues, one per line:>
  <SEVERITY> · <file>:<line> — <title>

Verdict: <recommendation> · Merge: <mergeDecision>
<one-line rationale>

Full JSON: $OUT
```

Rules:
- Sort issues CRITICAL → HIGH → MEDIUM → LOW, then by file.
- If more than 5 issues, append `(+ <N> more in JSON)` after the list.
- Render `<scope>` as `metadata.scope ?? 'unknown'` and `<model>` as `metadata.model ?? 'unknown'` (the CLI's `ReviewMetadata.scope` union currently omits `'repo'` even though that scope is supported — a known CLI bug; render defensively).
- Don't echo `positives` unless the user asked for the good news.

## Listing persisted findings (`findings` subcommand)

When the first token is `findings`, take this branch instead of Steps 3–5. Reads `.kode-review/findings/` directly — no model call, no pi auth required.

Parse remaining tokens as filters:

| Token(s) | Add flag |
|----------|----------|
| `open`, `uncertain`, `fixed`, `false-positive`, `wont-fix` (one or more, any order) | `--status <comma-joined>` |
| `critical`, `high`, `medium`, `low` (one or more) | `--severity <comma-joined>` |
| `blockers` (alias) | `--severity critical,high --status open,uncertain` |

Anything else flag-shaped (`--*`) passes through.

Invoke:

```bash
TMPDIR="${TMPDIR:-/tmp}"
OUT=$(mktemp "$TMPDIR/kode-findings.XXXXXX.json") || exit 1
kode-review --list-findings --format json --output-file "$OUT" --quiet \
  <filter flags>
```

Read `$OUT` (shape comes from `repo-audit/report.ts`, not the review-engine schema):

```json
{
  "total": 18, "openCount": 3, "uncertainCount": 0, "closedCount": 15,
  "byStatus": { "open": 3, "fixed": 15 }, "bySeverity": { "CRITICAL": 3 },
  "findings": [
    { "findingId": "...", "featureId": "...", "persona": "...",
      "status": "open|uncertain|fixed|false-positive|wont-fix",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "title": "...", "file": "src/x.ts", "lineStart": 42,
      "evidence": "...", "problem": "...", "recommendation": "..." }
  ]
}
```

Render:

```
kode-review findings: <total> total · <openCount> open · <closedCount> closed

  <SEVERITY> · <file>:<lineStart> — <title>  [<status>]
  ... up to 5 unresolved (open + uncertain), sorted CRITICAL → LOW ...

Full JSON: $OUT
```

If `total === 0` with no filters: reply "No findings on disk yet — run `/kode-review repo` to generate them." and stop. If a filter was applied but matched nothing: reply "No findings matched the filter (<N> on disk total)." and stop.

## Don't

- Don't run `--setup`, `--init-hooks`, `--index`, or `--reset` — those are operator-driven; tell the user to run them manually.
- Don't combine `--watch` with the JSON pipeline — watch mode is its own flow.
- Don't pretend success on non-zero exit. Show the stderr.
