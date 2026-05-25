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
  let revalidated = 0
  let closed = 0
  let uncertainCount = 0
  let stillPresent = 0
  // Open findings whose check failed or came back incomplete this run. They
  // are left untouched on disk so the next --revalidate retries them.
  let leftOpen = 0
  let featuresTouched = 0
  let abortLoop: { reason: string } | null = null

  // Group iterations are organized per-feature so the lock can guard the
  // whole feature's groups in one acquire/release cycle.
  const byFeature = new Map<string, FeatureGroup[]>()
  for (const g of groups) {
    const arr = byFeature.get(g.featureId) ?? []
    arr.push(g)
    byFeature.set(g.featureId, arr)
  }

  outer: for (const [featureId, featureGroups] of byFeature) {
    const feature = featureById.get(featureId)
    if (feature === undefined) {
      // Feature disappeared from clawpatch's map (re-mapped without it, or
      // never mapped — e.g. a finding from a previous repo layout). Verdict
      // every finding in every group as `'uncertain'`.
      logger.warn(
        cyan(`feature=${featureId}`) +
          ` — feature no longer in clawpatch map; marking findings as 'uncertain'.`,
      )
      for (const group of featureGroups) {
        for (const record of group.findings) {
          await persistVerdict(repoRoot, record, 'uncertain', runId, {
            agentEvidence: 'feature no longer present in clawpatch map',
          })
          revalidated += 1
          uncertainCount += 1
        }
      }
      featuresTouched += 1
      continue
    }

    const lock = await acquireFeatureLock(repoRoot, featureId, runId)
    if (lock === null) {
      logger.info(cyan(`feature=${featureId} skipped — locked by another runner`))
      continue
    }

    // Count the feature as touched at the start of work so a mid-run abort
    // (e.g. rate-limit) doesn't undercount the in-progress feature whose
    // partial verdicts were already persisted.
    featuresTouched += 1
    try {
      for (const group of featureGroups) {
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
            revalidated += 1
            uncertainCount += 1
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
            // abort — otherwise the run-history entry under-reports them.
            leftOpen += group.findings.length
            logger.error(
              `  ${group.persona}: rate limit hit — aborting the run. Already-written records are preserved. (${msg})`,
            )
            abortLoop = { reason: msg }
            break outer
          }
          // An engine failure is a failed check, not an observation about the
          // code. Leave the group's findings 'open' (untouched) so a later
          // --revalidate retries them; never flip to 'uncertain', which the
          // revalidate scan would then skip forever.
          const kind = isTransientModelError(err) ? 'transient model error' : 'error'
          logger.warn(
            `  ${group.persona}: ${kind} — leaving ${group.findings.length} finding(s) untouched for retry. (${msg})`,
          )
          leftOpen += group.findings.length
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
            leftOpen += 1
            continue
          }
          const verdict = verdictEntry.verdict
          await persistVerdict(repoRoot, record, verdict, runId, {
            agentEvidence: verdictEntry.evidence,
          })
          revalidated += 1
          if (verdict === 'fixed') closed += 1
          else if (verdict === 'uncertain') uncertainCount += 1
          else if (verdict === 'still-present') stillPresent += 1
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
  if (abortLoop !== null) {
    return {
      featuresReviewed: featuresTouched,
      featuresSkipped: 0,
      findingsEmitted: 0,
      findingsSuppressed: 0,
      findingsOnDisk,
      aborted: true,
      abortReason: abortLoop.reason,
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
