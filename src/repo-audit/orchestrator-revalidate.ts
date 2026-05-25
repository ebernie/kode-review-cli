/**
 * Orchestrator for `--scope repo --revalidate`.
 *
 * Re-checks each existing `status === 'open'` finding (plus `'uncertain'` ones
 * when `--retry-uncertain` is set) under `.kode-review/findings/` against the
 * current code and updates the record's lifecycle fields in place. Does NOT
 * produce new findings.
 *
 * Flow:
 *   1. Load all findings; filter to `status === 'open'` — and, with
 *      `--retry-uncertain`, also `status === 'uncertain'` (e.g. findings
 *      stranded by an earlier connection error).
 *   2. Optionally filter by `--since <ref>` (feature-level) and
 *      `--reviewers <names>` (per-record persona).
 *   3. Group by `(featureId, persona)`. For each group:
 *        - Acquire `acquireFeatureLock(repoRoot, featureId, runId)`.
 *        - If the persona is no longer registered, verdict all of the group
 *          as `'uncertain'` with a synthetic note; do not crash.
 *        - Otherwise call `revalidateFeatureGroupWithAgent` and apply the
 *          verdicts the agent actually rendered (including an explicit
 *          `'uncertain'`, which is a real "I looked and can't tell").
 *        - Persist each updated record via `writeFinding` immediately so
 *          partial progress survives a mid-run abort (rate limit, crash).
 *
 * `'uncertain'` vs. "leave open": `'uncertain'` is reserved for situations
 * where re-checking genuinely cannot help — the feature is gone from
 * clawpatch's map, the persona is no longer registered, or the agent looked
 * and explicitly couldn't decide. A *transient or incomplete check* (engine
 * error, unparseable block, a finding the agent silently dropped) is NOT an
 * observation about the code: those findings are left `'open'` and untouched
 * so a later `--revalidate` retries them naturally. Flipping them to
 * `'uncertain'` would be wrong twice over — it fabricates a verdict the agent
 * never made, and the revalidate scan (which only picks up `status === 'open'`)
 * would then skip them forever.
 *   4. Append a `RunHistoryEntry` with `mode: 'revalidate'` and counters.
 *
 * Immutable across revalidation: `createdAt`, `createdByRunId`, `persona`,
 * `featureId`, `finding`, `findingId`, `schemaVersion`. Only mutates:
 * `status`, `updatedAt`, `lastRevalidatedAt`, `revalidationVerdict`,
 * `revalidationRunId`.
 */
import { cyan, green, yellow } from '../cli/colors.js'
import { logger } from '../utils/logger.js'
import { runPool } from '../utils/concurrency.js'
import { resolveReviewer } from '../reviewers/registry.js'
import { isRateLimitError, isTransientModelError } from './error-classify.js'
import { filterFeaturesBySince } from './feature-filter.js'
import { readFeatures } from './features.js'
import { revalidateFeatureGroupWithAgent } from './engines/kode-agent-revalidate.js'
import type { RunRepoAuditOptions, RunRepoAuditResult } from './orchestrator.js'
import { verdictToStatus } from './revalidation-schema.js'
import {
  acquireFeatureLock,
  appendRunHistory,
  listFindings,
  newRunId,
  releaseFeatureLock,
  writeFinding,
} from './state.js'
import type { FeatureRecord, RepoFindingRecord, RevalidationVerdict } from './types.js'

/**
 * Top-level entry for `--scope repo --revalidate`. Called from
 * `runRepoAudit` when `cli.revalidate` is true.
 */
export async function runRevalidate(
  opts: RunRepoAuditOptions,
): Promise<RunRepoAuditResult> {
  const { cli, repoRoot } = opts

  // 1. Load all findings and isolate the ones to re-check. By default that is
  // just `open`; with --retry-uncertain we also re-check `uncertain` findings
  // (e.g. ones stranded by an earlier connection error) so a real verdict can
  // replace the "couldn't tell" state.
  const allRecords = await listFindings(repoRoot)
  const checkUncertain = cli.retryUncertain
  const unresolvedRecords = allRecords.filter(
    (r) => r.status === 'open' || (checkUncertain && r.status === 'uncertain'),
  )

  if (unresolvedRecords.length === 0) {
    const scopeNote = checkUncertain ? 'open or uncertain findings' : 'open findings'
    logger.success(green(`No ${scopeNote} on disk. Nothing to revalidate.`))
    return {
      featuresReviewed: 0,
      featuresSkipped: 0,
      findingsEmitted: 0,
      findingsSuppressed: 0,
      findingsOnDisk: allRecords.length,
    }
  }

  // 2a. --since filter at the feature level. We need the feature records to
  // call filterFeaturesBySince — but only for features that have at least
  // one open finding, so we don't pay for clawpatch's full feature read when
  // a single feature is in play.
  let scopedFeatureIds: Set<string> | null = null
  if (cli.since !== undefined) {
    const readResult = await readFeatures(repoRoot)
    const candidateIds = new Set(unresolvedRecords.map((r) => r.featureId))
    const relevantFeatures: FeatureRecord[] = readResult.features.filter((f) =>
      candidateIds.has(f.featureId),
    )
    const filtered = await filterFeaturesBySince(relevantFeatures, repoRoot, cli.since)
    scopedFeatureIds = new Set(filtered.matched.map((f) => f.featureId))
    logger.info(
      `--since ${cli.since}: ${filtered.touchedFiles.length} file(s) changed, ` +
        `${filtered.matched.length} feature(s) match`,
    )
  }

  // 2b. --reviewers filter at the persona level. `['general']` is the CLI
  // default and is treated as "no override" — matching the audit path.
  const reviewerOverride: readonly string[] | null =
    cli.reviewers === undefined || arraysEqual(cli.reviewers, ['general'])
      ? null
      : cli.reviewers
  const reviewerSet = reviewerOverride === null ? null : new Set(reviewerOverride)

  // Apply both filters and group.
  const inScope = unresolvedRecords.filter((r) => {
    if (scopedFeatureIds !== null && !scopedFeatureIds.has(r.featureId)) return false
    if (reviewerSet !== null && !reviewerSet.has(r.persona)) return false
    return true
  })

  if (inScope.length === 0) {
    logger.info(
      yellow(
        `0 of ${unresolvedRecords.length} finding(s) match the supplied filters; nothing to revalidate.`,
      ),
    )
    return {
      featuresReviewed: 0,
      featuresSkipped: 0,
      findingsEmitted: 0,
      findingsSuppressed: 0,
      findingsOnDisk: allRecords.length,
    }
  }

  // 3. Group by (featureId, persona). We also need the feature record for
  // each featureId so the prompt builder has feature metadata. Read features
  // once if we haven't already.
  const groups = groupByFeatureAndPersona(inScope)
  const featureIdsInPlay = new Set(groups.map((g) => g.featureId))
  const featureById = await loadFeatureRecords(repoRoot, featureIdsInPlay)

  const runId = newRunId()
  const startedAt = new Date().toISOString()

  // Group iterations are organized per-feature so the lock can guard the
  // whole feature's groups in one acquire/release cycle.
  const byFeature = new Map<string, FeatureGroup[]>()
  for (const g of groups) {
    const arr = byFeature.get(g.featureId) ?? []
    arr.push(g)
    byFeature.set(g.featureId, arr)
  }

  const featureEntries = Array.from(byFeature.entries())

  // Per-feature worker. Each call processes one feature's groups end-to-end,
  // accumulating into a LOCAL tally that the caller sums afterward. The worker
  // NEVER throws — engine failures are caught and reported via the tally;
  // a hard rate limit calls handle.requestStop() (so the pool stops dequeuing
  // new features) and records the reason — partial progress already persisted
  // to disk is preserved.
  async function reviewFeatureGroup(
    [featureId, featureGroups]: [string, FeatureGroup[]],
    _index: number,
    handle: { requestStop(): void; readonly stopRequested: boolean },
  ): Promise<FeatureTally> {
    const tally: FeatureTally = { ...ZERO_TALLY }

    try {
      const feature = featureById.get(featureId)
      if (feature === undefined) {
        // Feature disappeared from clawpatch's map (re-mapped without it, or
        // never mapped — e.g. a finding from a previous repo layout). Verdict
        // every finding in every group as `'uncertain'`.
        logger.warn(
          cyan(`feature=${featureId}`) +
            ` — feature no longer in clawpatch map; marking findings as 'uncertain'.`,
        )
        // No feature lock here: an orphaned feature (gone from clawpatch's map) is
        // keyed uniquely in `byFeature`, so it is handled by exactly one worker
        // in-process. Writes are atomic (temp-write-rename); a concurrent external
        // --revalidate is last-writer-wins with no corruption.
        for (const group of featureGroups) {
          for (const record of group.findings) {
            await persistVerdict(repoRoot, record, 'uncertain', runId, {
              agentEvidence: 'feature no longer present in clawpatch map',
            })
            tally.revalidated += 1
            tally.uncertain += 1
          }
        }
        tally.featuresTouched += 1
        return tally
      }

      const lock = await acquireFeatureLock(repoRoot, featureId, runId)
      if (lock === null) {
        logger.info(cyan(`feature=${featureId} skipped — locked by another runner`))
        return tally
      }

      // Count the feature as touched at the start of work so a mid-run abort
      // (e.g. rate-limit) doesn't undercount the in-progress feature whose
      // partial verdicts were already persisted.
      tally.featuresTouched += 1
      try {
        for (let groupIndex = 0; groupIndex < featureGroups.length; groupIndex++) {
          // A peer worker may have hit a hard rate limit and called
          // requestStop() while we were mid-feature. runPool's cooperative stop
          // only blocks dequeuing NEW features, so we must check between persona
          // groups too — otherwise we'd keep firing model calls at a provider we
          // already know is rate-limited. We only short-circuit groups AFTER the
          // first: a feature that was already dequeued is "in flight" and, per
          // runPool semantics, runs its first unit to completion (otherwise a
          // stop requested by a peer before this lane started its first group
          // would skip the whole feature). Subsequent persona groups are genuine
          // NEW work and are left 'open' for a later --revalidate.
          if (groupIndex > 0 && handle.stopRequested) {
            let remaining = 0
            for (let i = groupIndex; i < featureGroups.length; i++) {
              remaining += featureGroups[i]!.findings.length
            }
            if (remaining > 0) {
              tally.leftOpen += remaining
              logger.info(
                cyan(`feature=${featureId}`) +
                  ` stop requested by a peer worker — leaving ${remaining} finding(s) untouched for retry.`,
              )
            }
            return tally
          }

          const group = featureGroups[groupIndex]!
          logger.info(
            cyan(`feature=${featureId} persona=${group.persona}`) +
              ` revalidating ${group.findings.length} finding(s)`,
          )

          // Defend against findings whose persona is no longer registered.
          let persona
          try {
            persona = resolveReviewer(group.persona)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.warn(
              `  ${group.persona}: persona no longer registered — marking findings as 'uncertain'. (${msg})`,
            )
            for (const record of group.findings) {
              await persistVerdict(repoRoot, record, 'uncertain', runId, {
                agentEvidence: `persona "${group.persona}" no longer registered`,
              })
              tally.revalidated += 1
              tally.uncertain += 1
            }
            continue
          }

          let result
          try {
            result = await revalidateFeatureGroupWithAgent({
              feature,
              persona,
              openFindings: group.findings,
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
              // This group was attempted and failed; its findings stay 'open'
              // (unpersisted) for retry, so count them as left-open before we
              // stop — otherwise the run-history entry under-reports them.
              tally.leftOpen += group.findings.length
              tally.abortReason = msg
              logger.error(
                `  ${group.persona}: rate limit hit — stopping new work. Already-written records are preserved. (${msg})`,
              )
              handle.requestStop()
              return tally
            }
            // An engine failure is a failed check, not an observation about the
            // code. Leave the group's findings 'open' (untouched) so a later
            // --revalidate retries them; never flip to 'uncertain', which the
            // revalidate scan would then skip forever.
            const kind = isTransientModelError(err) ? 'transient model error' : 'error'
            logger.warn(
              `  ${group.persona}: ${kind} — leaving ${group.findings.length} finding(s) untouched for retry. (${msg})`,
            )
            tally.leftOpen += group.findings.length
            continue
          }

          if (!result.blockParsed) {
            logger.warn(
              `  ${group.persona}: agent did not emit a parseable kode-revalidations block (${result.blockError ?? 'unknown'}) — leaving findings untouched for retry.`,
            )
          }

          // Apply only the verdicts the agent actually rendered. A finding with
          // no emitted verdict was not checked (unparseable block, or the agent
          // silently dropped it), so we leave it 'open' and untouched — a later
          // --revalidate retries it. An explicit 'uncertain' verdict is honored:
          // that is the agent reporting "I looked and can't tell", not a failed
          // check.
          let missingCount = 0
          for (const record of group.findings) {
            const verdictEntry = result.verdicts.get(record.findingId)
            if (verdictEntry === undefined) {
              missingCount += 1
              tally.leftOpen += 1
              continue
            }
            const verdict = verdictEntry.verdict
            await persistVerdict(repoRoot, record, verdict, runId, {
              agentEvidence: verdictEntry.evidence,
            })
            tally.revalidated += 1
            if (verdict === 'fixed') tally.closed += 1
            else if (verdict === 'uncertain') tally.uncertain += 1
            else if (verdict === 'still-present') tally.stillPresent += 1
          }

          // Only warn about omissions when the block parsed — an unparseable
          // block already logged above, and every finding would be "missing".
          if (missingCount > 0 && result.blockParsed) {
            logger.warn(
              `  ${group.persona}: agent omitted ${missingCount} verdict(s); left untouched for retry.`,
            )
          }

          if (result.truncated) {
            logger.warn(`  ${group.persona}: ${result.truncationReason ?? 'truncated'}`)
          }
        }
      } finally {
        await releaseFeatureLock(repoRoot, featureId)
      }

      return tally
    } catch (err) {
      // The worker must never throw — runPool would otherwise reject and skip
      // run-history. An unexpected error (e.g. disk I/O in persistVerdict, or a
      // lock-acquire failure) is treated like a hard stop: report it, stop
      // scheduling new features, and leave any unpersisted findings 'open' on
      // disk for the next --revalidate. The inner try/finally has already
      // released the feature lock if one was held.
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(
        cyan(`feature=${featureId}`) +
          ` — unexpected error; stopping new work, remaining findings left for retry. (${msg})`,
      )
      tally.abortReason = msg
      handle.requestStop()
      return tally
    }
  }

  // --jobs governs the pool width; clamp to >= 1 so a stray 0 still runs.
  const concurrency = Math.max(1, cli.jobs)
  const outcome = await runPool(featureEntries, concurrency, reviewFeatureGroup)

  // Sum the per-feature tallies. The first feature to hit a hard rate limit
  // wins the abort reason; the pool stopped dequeuing new features once it did.
  let revalidated = 0
  let closed = 0
  let uncertainCount = 0
  let stillPresent = 0
  let leftOpen = 0
  let featuresTouched = 0
  let abortReason: string | null = null
  for (const t of outcome.results) {
    revalidated += t.revalidated
    closed += t.closed
    uncertainCount += t.uncertain
    stillPresent += t.stillPresent
    leftOpen += t.leftOpen
    featuresTouched += t.featuresTouched
    if (t.abortReason && abortReason === null) abortReason = t.abortReason
  }

  // Belt-and-suspenders: if the pool was stopped but no worker recorded a
  // reason (e.g. a future requestStop() path that forgets to set one), still
  // surface the abort rather than silently returning success.
  if (outcome.stopped && abortReason === null) {
    abortReason = 'revalidation stopped early (no reason recorded)'
  }

  await appendRunHistory(repoRoot, {
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    engine: 'kode-agent',
    mode: 'revalidate',
    featuresReviewed: featuresTouched,
    findingsEmitted: 0,
    findingsRevalidated: revalidated,
    findingsClosed: closed,
    findingsUncertain: uncertainCount,
    findingsStillPresent: stillPresent,
    findingsLeftOpen: leftOpen,
    model: cli.model,
    since: cli.since,
  })

  const findingsOnDisk = (await listFindings(repoRoot)).length
  if (abortReason !== null) {
    return {
      featuresReviewed: featuresTouched,
      featuresSkipped: 0,
      findingsEmitted: 0,
      findingsSuppressed: 0,
      findingsOnDisk,
      aborted: true,
      abortReason,
    }
  }

  const leftOpenSuffix = leftOpen > 0 ? `, ${leftOpen} left for retry` : ''
  logger.success(
    green(
      `Revalidation complete: ${revalidated} checked, ${closed} now fixed, ${uncertainCount} uncertain${leftOpenSuffix}.`,
    ),
  )

  return {
    featuresReviewed: featuresTouched,
    featuresSkipped: 0,
    findingsEmitted: 0,
    findingsSuppressed: 0,
    findingsOnDisk,
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

interface FeatureGroup {
  featureId: string
  persona: string
  findings: RepoFindingRecord[]
}

/**
 * Counters accumulated while reviewing a single feature's groups. Each pool
 * worker returns one of these; `runRevalidate` sums them into the run totals.
 * Keeping the tally local (not shared mutable outer-scope counters) is what
 * makes parallel feature workers safe.
 */
interface FeatureTally {
  featuresTouched: number
  revalidated: number
  closed: number
  uncertain: number
  stillPresent: number
  leftOpen: number
  /** Set when this feature's work hit a hard rate limit. */
  abortReason?: string
}

const ZERO_TALLY: FeatureTally = {
  featuresTouched: 0,
  revalidated: 0,
  closed: 0,
  uncertain: 0,
  stillPresent: 0,
  leftOpen: 0,
}

function groupByFeatureAndPersona(records: RepoFindingRecord[]): FeatureGroup[] {
  const map = new Map<string, FeatureGroup>()
  for (const r of records) {
    const key = `${r.featureId}\0${r.persona}`
    const existing = map.get(key)
    if (existing === undefined) {
      map.set(key, { featureId: r.featureId, persona: r.persona, findings: [r] })
    } else {
      existing.findings.push(r)
    }
  }
  return Array.from(map.values())
}

/**
 * Read clawpatch's features and project them into a map keyed by featureId,
 * restricted to the ids we actually need. Missing ids are handled by the
 * caller (verdict 'uncertain').
 */
async function loadFeatureRecords(
  repoRoot: string,
  ids: Set<string>,
): Promise<Map<string, FeatureRecord>> {
  if (ids.size === 0) return new Map()
  let features: FeatureRecord[]
  try {
    const result = await readFeatures(repoRoot)
    features = result.features
  } catch (err) {
    // clawpatch may not have mapped this repo. Return empty so every
    // affected finding gets verdicted 'uncertain' rather than crashing.
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(
      `Could not read clawpatch features (${msg}) — findings whose features are unknown will be marked 'uncertain'.`,
    )
    return new Map()
  }
  const map = new Map<string, FeatureRecord>()
  for (const f of features) {
    if (ids.has(f.featureId)) map.set(f.featureId, f)
  }
  return map
}

/**
 * Apply a verdict to a finding record and write it back to disk atomically.
 * Mutates only the lifecycle fields; all other fields are preserved verbatim.
 */
async function persistVerdict(
  repoRoot: string,
  original: RepoFindingRecord,
  verdict: RevalidationVerdict,
  runId: string,
  extra: { agentEvidence?: string } = {},
): Promise<void> {
  const now = new Date().toISOString()
  const updated: RepoFindingRecord = {
    ...original,
    status: verdictToStatus(verdict),
    updatedAt: now,
    lastRevalidatedAt: now,
    revalidationVerdict: verdict,
    revalidationRunId: runId,
  }
  await writeFinding(repoRoot, updated)
  if (extra.agentEvidence !== undefined && extra.agentEvidence.length > 0) {
    // Keep the per-finding note in the log only — the structured record
    // does not have a free-form evidence slot, and we deliberately leave
    // the inner `finding` object untouched.
    logger.info(
      `    ${original.findingId} → ${verdict}: ${extra.agentEvidence}`,
    )
  } else {
    logger.info(`    ${original.findingId} → ${verdict}`)
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
