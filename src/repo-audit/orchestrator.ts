/**
 * Repo-audit orchestrator: ties together install detection, clawpatch map,
 * feature read, persona dispatch, the kode-agent engine, and state persistence.
 *
 * Features are independent units of work, so the review step runs them through
 * a bounded worker pool (`runPool`, width = `--jobs`). Each worker returns a
 * local tally; the caller sums them. A hard rate limit cooperatively stops the
 * pool from dequeuing new features while letting in-flight ones finish, so
 * partial progress already written to disk is preserved.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cyan, green, yellow } from '../cli/colors.js'
import type { CliOptions } from '../cli/args.js'
import { resolveReviewer } from '../reviewers/registry.js'
import { logger } from '../utils/logger.js'
import { runPool } from '../utils/concurrency.js'
import { runClawpatchInit, runClawpatchMap } from './clawpatch-cli.js'
import { reviewFeatureWithAgent } from './engines/kode-agent.js'
import { isRateLimitError, isTransientModelError } from './error-classify.js'
import { filterFeaturesBySince } from './feature-filter.js'
import { CLAWPATCH_STATE_DIR, pendingFeatures, readFeatures } from './features.js'
import { runRevalidate } from './orchestrator-revalidate.js'
import {
  buildInstallHint,
  buildNodeUpgradeHint,
  detectClawpatch,
  isNodeVersionCompatible,
} from './install.js'
import { resolvePersonasWithOverride } from './persona-dispatch.js'
import {
  acquireFeatureLock,
  appendRunHistory,
  computeFindingId,
  listFindings,
  newRunId,
  releaseFeatureLock,
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
  /** True if a transient/terminal error stopped the loop before all features were reviewed. */
  aborted?: boolean
  /** Human-readable explanation when aborted is true (e.g. rate-limit notice). */
  abortReason?: string
}

/**
 * Top-level entry for `--scope repo`. Called from src/index.ts when scope
 * resolves to 'repo'.
 *
 * Behavior gates:
 *   --report-only  → skip map + review; just render what's on disk
 *   --revalidate   → delegate to orchestrator-revalidate.ts (no new findings)
 *   --remap        → pass --force to `clawpatch map`
 *   --since <ref>  → filter features
 *   --engine clawpatch → escape hatch
 */
export async function runRepoAudit(
  opts: RunRepoAuditOptions,
): Promise<RunRepoAuditResult> {
  const { cli, repoRoot } = opts

  // --revalidate runs a parallel orchestration path that re-checks open
  // findings against current code instead of producing new findings. It
  // shares the same options shape so callers (src/index.ts) don't branch.
  if (cli.revalidate) {
    return runRevalidate(opts)
  }

  // Report-only short-circuit runs BEFORE any environment gate: this path
  // only reads `.kode-review/findings/`, never shells out to clawpatch, and
  // must work on Node 18+ where users have existing reports to inspect.
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

  // Hard gate: Node 22+ required (clawpatch's minimum).
  if (!isNodeVersionCompatible()) {
    throw new Error(buildNodeUpgradeHint())
  }

  // Hard gate: clawpatch must be on PATH.
  const status = await detectClawpatch()
  if (!status.installed) {
    throw new Error(buildInstallHint(repoRoot))
  }
  if (status.version !== null) {
    logger.info(`Detected ${status.version}`)
  }

  // Step 1: ensure clawpatch is initialized in this repo. `clawpatch map`
  // requires `.clawpatch/` to already exist (exits 2 with "not initialized"
  // otherwise), so we run `clawpatch init` on first use. The directory
  // check is more reliable than parsing stderr — wording can drift across
  // clawpatch versions.
  if (!(await clawpatchStateDirExists(repoRoot))) {
    logger.info('Initializing clawpatch state (first run in this repo)…')
    const initResult = await runClawpatchInit(repoRoot)
    if (initResult.exitCode !== 0) {
      // Race: another runner may have initialized between our dir check and
      // our init call. If the dir is now present, treat that as success;
      // otherwise the failure is real.
      if (await clawpatchStateDirExists(repoRoot)) {
        logger.info('clawpatch state appeared concurrently — continuing.')
      } else {
        throw new Error(
          `clawpatch init failed (exit ${initResult.exitCode}). stderr:\n${initResult.stderr.trim() || '(empty)'}`,
        )
      }
    }
  }

  // Step 2: map the repo.
  logger.info(cli.remap ? 'Re-mapping repository via clawpatch…' : 'Mapping repository via clawpatch…')
  const mapResult = await runClawpatchMap(repoRoot, { force: cli.remap })
  if (mapResult.exitCode !== 0) {
    throw new Error(
      `clawpatch map failed (exit ${mapResult.exitCode}). stderr:\n${mapResult.stderr.trim() || '(empty)'}`,
    )
  }

  // Step 3: read features.
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

  // Step 4a: --since <ref> reduces the feature set to those whose owned
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

  // Step 4b: skip features that already have findings on disk unless
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

  // Step 5: review each pending feature. Features are independent units of
  // work — a bounded worker pool reviews up to `--jobs` of them in parallel.
  // Each worker accumulates into a LOCAL tally that the caller sums afterward;
  // keeping the tally local (not shared mutable outer-scope counters) is what
  // makes parallel feature workers safe. The worker NEVER throws — engine
  // failures are caught and reported via the tally; a hard rate limit calls
  // handle.requestStop() so the pool stops dequeuing new features, while
  // partial progress already persisted to disk is preserved.
  const runId = newRunId()
  const startedAt = new Date().toISOString()

  interface AuditTally {
    reviewed: number
    emitted: number
    suppressed: number
    abortReason?: string
  }

  async function reviewFeature(
    feature: (typeof toReview)[number],
    _index: number,
    handle: { requestStop(): void; readonly stopRequested: boolean },
  ): Promise<AuditTally> {
    const tally: AuditTally = { reviewed: 0, emitted: 0, suppressed: 0 }
    try {
      const personaNames = resolvePersonasWithOverride(
        feature,
        cli.reviewers === undefined || arraysEqual(cli.reviewers, ['general']) ? [] : cli.reviewers,
      )

      // Acquire an exclusive per-feature lock so concurrent audits on the same
      // repo don't double-spend model budget or race on the deterministic
      // finding-file path. A held lock means another runner is already on it —
      // skip and let that runner finish.
      const lock = await acquireFeatureLock(repoRoot, feature.featureId, runId)
      if (lock === null) {
        logger.info(cyan(`feature=${feature.featureId} skipped — locked by another runner`))
        return tally
      }

      logger.info(cyan(`feature=${feature.featureId} personas=${personaNames.join(',')}`))

      try {
        for (let personaIndex = 0; personaIndex < personaNames.length; personaIndex++) {
          // A peer worker may have hit a hard rate limit and called
          // requestStop() while we were mid-feature. runPool's cooperative stop
          // only blocks dequeuing NEW features, so we must check between
          // personas too — otherwise we'd keep firing model calls at a provider
          // we already know is rate-limited. We only short-circuit AFTER the
          // first persona: a feature that was already dequeued is "in flight"
          // and runs its first unit to completion (a stop requested by a peer
          // before this lane began would otherwise skip the whole feature).
          if (personaIndex > 0 && handle.stopRequested) {
            logger.info(
              cyan(`feature=${feature.featureId}`) +
                ` stop requested by a peer worker — skipping remaining persona(s).`,
            )
            break
          }

          const name = personaNames[personaIndex]!
          let persona
          try {
            persona = resolveReviewer(name)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.warn(`  ${name}: reviewer not registered — skipping this persona. (${msg})`)
            continue
          }
          let result
          try {
            result = await reviewFeatureWithAgent({
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
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (isRateLimitError(err)) {
              logger.error(
                `  ${persona.name}: rate limit hit — stopping new work. Already-written findings are preserved. (${msg})`,
              )
              tally.abortReason = msg
              handle.requestStop()
              tally.reviewed += 1
              return tally
            }
            if (isTransientModelError(err)) {
              logger.warn(`  ${persona.name}: transient model error — skipping this persona. (${msg})`)
            } else {
              logger.warn(`  ${persona.name}: error — skipping this persona. (${msg})`)
            }
            continue
          }

          // Apply structured suppression filter (unless --no-suppressions).
          let kept = result.findings
          if (!cli.noSuppressions) {
            const filtered = await filterSuppressedStructured(result.findings, repoRoot)
            kept = filtered.kept
            tally.suppressed += filtered.suppressedCount
            if (filtered.suppressedCount > 0) {
              logger.info(
                yellow(`  Suppressed ${filtered.suppressedCount} finding(s) via kode-review: ignore markers`),
              )
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
            tally.emitted += 1
          }

          if (result.truncated) {
            logger.warn(`  ${persona.name}: ${result.truncationReason ?? 'truncated'}`)
          }
        }
      } finally {
        await releaseFeatureLock(repoRoot, feature.featureId)
      }

      tally.reviewed += 1
      return tally
    } catch (err) {
      // The worker must never throw — runPool would otherwise reject and skip
      // run-history. An unexpected error (e.g. disk I/O in writeFinding, or a
      // lock-acquire failure) is treated like a hard stop. The inner finally
      // has already released the lock if held.
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(
        cyan(`feature=${feature.featureId}`) +
          ` — unexpected error; stopping new work. (${msg})`,
      )
      tally.abortReason = msg
      handle.requestStop()
      return tally
    }
  }

  const concurrency = Math.max(1, cli.jobs)
  const outcome = await runPool(toReview, concurrency, reviewFeature)

  // Sum the per-feature tallies. The first feature to hit a hard rate limit
  // wins the abort reason; the pool stopped dequeuing new features once it did.
  let totalEmitted = 0
  let totalSuppressed = 0
  let reviewed = 0
  let abortReason: string | null = null
  for (const t of outcome.results) {
    totalEmitted += t.emitted
    totalSuppressed += t.suppressed
    reviewed += t.reviewed
    if (t.abortReason && abortReason === null) abortReason = t.abortReason
  }
  // Belt-and-suspenders: if the pool was stopped but no worker recorded a
  // reason, still surface the abort rather than silently returning success.
  if (outcome.stopped && abortReason === null) {
    abortReason = 'audit stopped early (no reason recorded)'
  }

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
    ...(abortReason !== null ? { aborted: true, abortReason } : {}),
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

async function clawpatchStateDirExists(repoRoot: string): Promise<boolean> {
  try {
    const s = await stat(join(repoRoot, CLAWPATCH_STATE_DIR))
    return s.isDirectory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
