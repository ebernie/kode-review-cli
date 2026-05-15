# CI examples

These are starting points. Copy whichever file matches your platform into your
repository and adjust the model/provider env vars to match your pi config.

## What `--ci` does

`--ci` bundles:

- `--agentic` (multi-step review with tools)
- `--quiet` (no spinner, machine-friendly stdout)
- `--format markdown`
- `--post-to-pr` (uses `gh`/`glab` to post a comment)
- `--fail-on critical` (default; exit non-zero when CRITICAL findings exist)

The indexer is **not required** in CI mode — agentic tools fall back to
ripgrep + git.

## Checking out the right ref

- **GitHub Actions:** the default `actions/checkout@v4` step uses the *merge ref*
  on `pull_request` events. Override to `github.event.pull_request.head.sha` so
  the review applies to the source as the author wrote it. `fetch-depth: 0`
  is required for commit-message tools.

- **GitLab CI:** source is auto-checked-out on `merge_request_event`, but
  shallow by default. Set `GIT_DEPTH: 0` to enable commit-message tools.

## Permissions

- **GitHub:** the job needs `permissions: pull-requests: write` so `gh` can
  post and delete comments using the built-in `GITHUB_TOKEN`. Sticky-comment
  replacement requires both write and delete on issue comments.
- **GitLab:** create a project-level access token with `api` scope and store
  it as the `GITLAB_TOKEN` CI variable.

## Sticky comments

Each `--ci` run posts a single comment and deletes any prior comments tagged
with `<!-- kode-review:sticky -->`. The new comment is posted *before* the
old one is deleted, so the PR is never briefly left without a current
review. Human comments on the PR are never touched.

## Suppressing specific findings

Inline magic comment in source code:

```ts
const password = '...'; // kode-review: ignore
```

Suppresses any finding on the same line **or the line immediately below**.
Works in any language — we only look for the literal string `kode-review:
ignore`, regardless of the comment syntax (`//`, `#`, `--`, `<!-- -->`, etc.).

File-level suppression — drops every finding in the file:

```ts
// kode-review: ignore-file
```

To disable suppression handling and see every finding the model produced,
pass `--no-suppressions` (useful for debugging false positives in the
filter itself).

## Severity gating

`--fail-on critical` (default) exits 1 only when CRITICAL findings exist.
`--fail-on high` exits 1 on CRITICAL or HIGH findings.
`--fail-on none` always exits 0, even when issues are present (useful while
tuning the model).

An `APPROVE` verdict from the model always yields exit 0, regardless of the
`--fail-on` threshold.
