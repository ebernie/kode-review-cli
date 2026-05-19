/**
 * Repo-audit orchestrator: ties together install detection, clawpatch map,
 * feature read, persona dispatch, the kode-agent engine, and state persistence.
 *
 * For v1 (walking skeleton): sequential per-feature review. The worker pool
 * + risk-prioritized order land in task #8 (runner.ts).
 */
import { cyan, green, yellow } from '../cli/colors.js'
import type { CliOptions } from '../cli/args.js'
import { resolveReviewer } from '../reviewers/registry.js'
import { logger } from '../utils/logger.js'
import { runClawpatchMap } from './clawpatch-cli.js'
import { reviewFeatureWithAgent } from './engines/kode-agent.js'
import { filterFeaturesBySince } from './feature-filter.js'
import { pendingFeatures, readFeatures } from './features.js'
import {
  buildInstallHint,
  buildNodeUpgradeHint,
  detectClawpatch,
  isNodeVersionCompatible,
} from './install.js'
import { resolvePersonasWithOverride } from './persona-dispatch.js'
import {
  appendRunHistory,
  computeFindingId,
  listFindings,
  newRunId,
  writeFinding,
} from './state.js'
import { filterSuppressedStructured } from './suppressions-structured.js'
import type { RepoFindingRecord } from './types.js'

export interface RunRepoAuditOptions {
  repoRoot: string
  repoUrl: string
  branch?: string
  indexerUrl?: string
  cli: CliOptions
}

export interface RunRepoAuditResult {
  featuresReviewed: number
  featuresSkipped: number
  findingsEmitted: number
  findingsSuppressed: number
  /** Total findings on disk after the run (open + closed). */
  findingsOnDisk: number
}

/**
 * Top-level entry for `--scope repo`. Called from src/index.ts when scope
 * resolves to 'repo'.
 *
 * Behavior gates:
 *   --report-only  → skip map + review; just render what's on disk
 *   --revalidate   → handled by a sibling path (orchestrator-revalidate.ts; task #12)
 *   --remap        → pass --force to `clawpatch map`
 *   --since <ref>  → filter features (task #7)
 *   --engine clawpatch → escape hatch (task #10)
 */
export async function runRepoAudit(
  opts: RunRepoAuditOptions,
): Promise<RunRepoAuditResult> {
  const { cli, repoRoot } = opts

  // --revalidate is reserved for a future PR but the CLI flag is accepted.
  // Without an explicit error, a user passing --revalidate would silently
  // run a full audit (the wrong operation).
  if (cli.revalidate) {
    throw new Error(
      '--revalidate is not yet implemented in this build. ' +
        'Use --remap to force re-review against current code; ' +
        'or remove `.kode-review/findings/<id>.json` files individually to re-review specific findings.',
    )
  }

  // Hard gate: Node 22+ required (clawpatch's minimum).
  if (!isNodeVersionCompatible()) {
    throw new Error(buildNodeUpgradeHint())
  }

  // Hard gate: clawpatch must be on PATH (unless --report-only, which never
  // shells out to clawpatch — we just read .clawpatch/features/ if present).
  if (!cli.reportOnly) {
    const status = await detectClawpatch()
    if (!status.installed) {
      throw new Error(buildInstallHint(repoRoot))
    }
    if (status.version !== null) {
      logger.info(`Detected ${status.version}`)
    }
  }

  // Report-only short circuit.
  if (cli.reportOnly) {
    const records = await listFindings(repoRoot)
    return {
      featuresReviewed: 0,
      featuresSkipped: 0,
      findingsEmitted: 0,
      findingsSuppressed: 0,
      findingsOnDisk: records.length,
    }
  }

  // Step 1: ensure clawpatch has mapped this repo (idempotent; auto-inits).
  logger.info(cli.remap ? 'Re-mapping repository via clawpatch…' : 'Mapping repository via clawpatch…')
  const mapResult = await runClawpatchMap(repoRoot, { force: cli.remap })
  if (mapResult.exitCode !== 0) {
    throw new Error(
      `clawpatch map failed (exit ${mapResult.exitCode}). stderr:\n${mapResult.stderr.trim() || '(empty)'}`,
    )
  }

  // Step 2: read features.
  const readResult = await readFeatures(repoRoot)
  if (readResult.features.length === 0) {
    logger.warn('clawpatch produced no features for this repo. Nothing to review.')
    return {
      featuresReviewed: 0,
      featuresSkipped: 0,
      findingsEmitted: 0,
      findingsSuppressed: 0,
      findingsOnDisk: (await listFindings(repoRoot)).length,
    }
  }
  if (readResult.skipped.length > 0) {
    logger.warn(`Skipped ${readResult.skipped.length} malformed feature file(s).`)
  }
  logger.success(`Mapped ${readResult.features.length} features.`)

  // Step 3a: --since <ref> reduces the feature set to those whose owned
  // files changed in the diff range. Applied before the "already-reviewed"
  // filter so the user can re-review touched features with --since +
  // --remap together.
  let scoped = readResult.features
  if (cli.since !== undefined) {
    const filtered = await filterFeaturesBySince(scoped, repoRoot, cli.since)
    logger.info(
      `--since ${cli.since}: ${filtered.touchedFiles.length} file(s) changed, ` +
        `${filtered.matched.length} feature(s) match`,
    )
    scoped = filtered.matched
  }

  // Step 3b: skip features that already have findings on disk unless
  // --remap (a remap means clawpatch may have re-shaped features; a
  // previous review's findings may be stale, so re-review).
  //
  // Build the "already reviewed" set with a single listFindings call. The
  // earlier version called hasFindingsForFeature per-candidate, which is
  // O(N x M) — a 500-feature repo with 200 pending would re-read 100k
  // finding files at startup.
  const candidates = pendingFeatures(scoped)
  const reviewedFeatureIds = cli.remap
    ? new Set<string>()
    : new Set((await listFindings(repoRoot)).map((r) => r.featureId))
  const toReview = candidates.filter((f) => !reviewedFeatureIds.has(f.featureId))
  const skipped = candidates.length - toReview.length
  if (skipped > 0) {
    logger.info(`Skipping ${skipped} feature(s) already reviewed (use --remap to re-review).`)
  }
  if (toReview.length === 0) {
    logger.success(green('All mapped features have findings on disk. Nothing to do.'))
    return {
      featuresReviewed: 0,
      featuresSkipped: skipped,
      findingsEmitted: 0,
      findingsSuppressed: 0,
      findingsOnDisk: (await listFindings(repoRoot)).length,
    }
  }

  // Step 4: review each pending feature.
  const runId = newRunId()
  const startedAt = new Date().toISOString()
  let totalEmitted = 0
  let totalSuppressed = 0
  let reviewed = 0

  for (const feature of toReview) {
    const personaNames = resolvePersonasWithOverride(feature, cli.reviewers === undefined || arraysEqual(cli.reviewers, ['general']) ? [] : cli.reviewers)
    logger.info(
      cyan(`feature=${feature.featureId} personas=${personaNames.join(',')}`),
    )

    for (const name of personaNames) {
      const persona = resolveReviewer(name)
      const result = await reviewFeatureWithAgent({
        feature,
        persona,
        repoRoot,
        repoUrl: opts.repoUrl,
        branch: opts.branch,
        indexerUrl: opts.indexerUrl,
        model: cli.model,
        maxIterations: cli.maxIterations,
        timeoutSec: cli.agenticTimeout,
      })

      // Apply structured suppression filter (unless --no-suppressions).
      let kept = result.findings
      let suppressedThisRun = 0
      if (!cli.noSuppressions) {
        const filtered = await filterSuppressedStructured(result.findings, repoRoot)
        kept = filtered.kept
        suppressedThisRun = filtered.suppressedCount
        totalSuppressed += suppressedThisRun
        if (suppressedThisRun > 0) {
          logger.info(yellow(`  Suppressed ${suppressedThisRun} finding(s) via kode-review: ignore markers`))
        }
      }

      // Persist findings.
      for (const f of kept) {
        const findingId = computeFindingId(feature.featureId, f.file, f.lineStart, f.title)
        const record: RepoFindingRecord = {
          schemaVersion: 1,
          findingId,
          featureId: feature.featureId,
          persona: persona.name,
          status: 'open',
          finding: f,
          createdByRunId: runId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        await writeFinding(repoRoot, record)
        totalEmitted += 1
      }

      if (result.truncated) {
        logger.warn(`  ${persona.name}: ${result.truncationReason ?? 'truncated'}`)
      }
    }

    reviewed += 1
  }

  // Record run history.
  await appendRunHistory(repoRoot, {
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    engine: 'kode-agent',
    featuresReviewed: reviewed,
    findingsEmitted: totalEmitted,
    model: cli.model,
    since: cli.since,
  })

  return {
    featuresReviewed: reviewed,
    featuresSkipped: skipped,
    findingsEmitted: totalEmitted,
    findingsSuppressed: totalSuppressed,
    findingsOnDisk: (await listFindings(repoRoot)).length,
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
