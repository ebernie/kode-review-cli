---
name: kode-review
description: |
  Run an AI-powered code review of the current git state via the `kode-review` CLI
  (https://github.com/ebernie/kode-review-cli). Auto-detects scope (uncommitted vs
  ahead-of-base vs a specific PR vs whole repo) and surfaces findings inline.
  Use when the user says "review my changes", "review my branch", "review my PR",
  "review PR #N", "kode review", "audit this repo", "audit the codebase",
  "check my diff", or asks for bug-finding on the current working state.
triggers:
  - review my changes
  - review my branch
  - review my PR
  - review this PR
  - review PR
  - review my work
  - review my code
  - kode review
  - kode-review
  - run a review
  - run kode-review
  - give me a code review
  - audit this repo
  - audit the codebase
  - check my diff
  - check my code
  - look at my PR
  - find bugs in my changes
  - code review my work
allowed-tools:
  - Bash
  - Read
---

# kode-review skill

Wrap the `kode-review` CLI so the user can ask for a review in plain English and get findings summarized inline. The CLI does the heavy lifting (diff extraction, model call, structured parsing). This skill picks the right `--scope`, runs the binary, and renders the result.

## Preflight (always first)

```bash
command -v kode-review >/dev/null
```

If missing → reply:

> `kode-review` is not on PATH. Install with `npm i -g @ebernie/kode-review-cli` (or `bun add -g @ebernie/kode-review-cli`), then run `kode-review --setup` to configure the AI provider via pi (https://pi.dev).

Then stop. Don't try to run anything else.

## Scope selection

Pick from the user's phrasing first; fall back to git state.

| User phrasing | Scope flags |
|---------------|-------------|
| Includes `PR #N`, `MR !N`, or a GitHub/GitLab PR URL | `--scope pr --pr <N>` |
| "review my PR" / "review this PR" on a feature branch (no number) | `--scope pr` |
| "audit this repo", "audit the codebase", "whole repo" | `--scope repo` |
| "review my changes" / "review my branch" / "kode review" | smart-detect below |
| "watch for PRs", "monitor reviewers" | `--watch` — but **confirm** before launching (long-running) |

### Smart-detect (default branch)

Guard the git state first — bail with a clear message on any failure:

```bash
# Inside a git work tree?
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "NOT_A_REPO"; exit 0; }

# On a real branch? (Detached HEAD breaks @{u} and has no clean base for smart-detect.)
git symbolic-ref -q HEAD >/dev/null || { echo "DETACHED"; exit 0; }
```

- `NOT_A_REPO` → "Not inside a git working tree. Re-run from a repo, or use an explicit scope." Stop.
- `DETACHED` → "On a detached HEAD — smart-detect can't infer a base. Ask the user to either check out a branch or specify an explicit scope (`local`, `pr <N>`, or `repo`)." Stop.

Then probe state. `@{u}` requires a configured upstream; fall back to `origin/HEAD` when missing:

```bash
UNCOMMITTED=$(git status --porcelain 2>/dev/null | head -c1)
if git rev-parse --abbrev-ref @{u} >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)
elif git rev-parse origin/HEAD >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count origin/HEAD..HEAD 2>/dev/null || echo 0)
else
  AHEAD=0  # no remote to compare against — only uncommitted changes can be reviewed
fi
```

| Condition | Scope |
|-----------|-------|
| `UNCOMMITTED` non-empty AND `AHEAD > 0` | `--scope both` |
| `UNCOMMITTED` non-empty only | `--scope local` |
| `AHEAD > 0` only | `--scope pr` |
| Neither | Reply "Nothing to review — clean tree, no commits ahead of base." and stop. |

State the chosen scope in one sentence before running. If `@{u}` was missing and you fell back to `origin/HEAD`, mention that so the user can fix the upstream config if they want.

## Flag passthrough (conversational)

Honor these when the user mentions them:

| User said | Add flag |
|-----------|----------|
| "use the security reviewer" / "security review" | `--reviewer security` |
| "use the architect reviewer" | `--reviewer architect` |
| "run all reviewers" | `--reviewer all` |
| "with semantic context" / "with indexer context" | `--with-context` |
| "post to PR" / "leave a comment" | `--post-to-pr` |
| "use model X" | `--model X` |
| "non-agentic" / "diff only" | `--no-agentic` |

## Invocation

Always:

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

`--quiet` suppresses stdout — the JSON only lands in `$OUT`. Don't drop `--output-file`.

If `RC != 0` → print stderr verbatim and stop. Common cases:

- "pi not authenticated" → tell the user to run `pi /login`.
- "Indexer not running" (only with `--with-context`) → tell them to run `kode-review --setup-indexer`.

## Output format

Read `$OUT` and render.

### If `parseError: true`

The CLI couldn't parse the model's response into structured findings. Emit ONLY this — no header line, no counts, no findings table, no verdict:

```
kode-review: structured parsing failed — see raw output in $OUT
```

Then stop. Do NOT fabricate counts or findings from an empty `issueCount`.

### Normal path

```
kode-review (<scope>, <model>): <total> findings (<C> CRITICAL, <H> HIGH, <M> MED, <L> LOW)

  <SEVERITY> · <file>:<line> — <title>
  <SEVERITY> · <file>:<line> — <title>
  ... up to 5 ...

Verdict: <recommendation> · Merge: <mergeDecision>
<one-line rationale>

Full JSON: $OUT
```

Rules:
- Sort issues `CRITICAL → HIGH → MEDIUM → LOW`, then by file path.
- Pad severity column for alignment (`CRITICAL`, `HIGH    `, `MEDIUM  `, `LOW     `).
- If `> 5` issues, append `(+ <N> more in JSON)`.
- Render `<scope>` as `metadata.scope ?? 'unknown'` and `<model>` as `metadata.model ?? 'unknown'`. The CLI's `ReviewMetadata.scope` type union currently omits `'repo'` (a known CLI bug at `src/output/types.ts:56`); a repo-scope run may render as `unknown` until that union is fixed.
- Don't print `positives` unless the user explicitly asked for the good news.

## JSON shape (for parsing reference)

```json
{
  "summary": "string",
  "issues": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "string",
      "title": "string",
      "file": "src/x.ts",
      "line": 42,
      "endLine": 50,
      "description": "string",
      "suggestion": "string",
      "confidence": "HIGH|MEDIUM|LOW"
    }
  ],
  "issueCount": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "positives": ["string"],
  "verdict": {
    "recommendation": "APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION",
    "confidence": "HIGH|MEDIUM|LOW",
    "mergeDecision": "SAFE_TO_MERGE|DO_NOT_MERGE|CONDITIONAL_MERGE",
    "rationale": "string"
  },
  "metadata": { "scope": "...", "model": "...", "agentic": true, "branch": "...", "prNumber": 42 }
}
```

## Follow-ups

If the user asks about a specific finding ("tell me more about #2", "explain the auth one"), `Read` the saved JSON at `$OUT` and answer from the `description` + `suggestion` fields. Don't re-run the review.

If the user asks to fix a finding, treat it as a normal edit task — read the cited file, apply the change, then offer to re-run the review to confirm.

## Don't

- Don't run `--setup`, `--init-hooks`, `--index`, `--index-reset`, or `--reset` automatically — these are operator tasks. Tell the user the exact command and let them run it.
- Don't combine `--watch` with the JSON pipeline — watch is a long-running daemon, fundamentally different from a one-shot review.
- Don't claim success on a non-zero exit code.
- Don't omit `--output-file` — `--quiet` will swallow stdout and you'll have nothing to parse.
- Don't run `--scope repo` without flagging that it can take a while (whole-codebase audit, multiple model calls).
