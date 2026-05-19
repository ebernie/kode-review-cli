/**
 * Read clawpatch's `.clawpatch/features/*.json` into FeatureRecord[].
 *
 * Strictly read-only: --scope repo never writes into `.clawpatch/`. Files
 * with an unsupported schemaVersion are surfaced as warnings (not errors)
 * and skipped, so a clawpatch upgrade doesn't break the whole audit.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../utils/logger.js'
import { FeatureRecordSchema, SUPPORTED_FEATURE_SCHEMA_VERSION, type FeatureRecord } from './types.js'

export const CLAWPATCH_STATE_DIR = '.clawpatch'
export const CLAWPATCH_FEATURES_DIR = 'features'

export function clawpatchFeaturesDir(repoRoot: string): string {
  return join(repoRoot, CLAWPATCH_STATE_DIR, CLAWPATCH_FEATURES_DIR)
}

export interface ReadFeaturesResult {
  features: FeatureRecord[]
  /** Files that couldn't be parsed; non-fatal. */
  skipped: Array<{ path: string; reason: string }>
}

/**
 * Read every `*.json` file in `.clawpatch/features/`. Returns a structured
 * result so the caller can decide how to surface skips to the user.
 *
 * If the directory doesn't exist, returns empty arrays — callers should
 * treat this as "no features mapped yet, run `clawpatch map`."
 */
export async function readFeatures(repoRoot: string): Promise<ReadFeaturesResult> {
  const dir = clawpatchFeaturesDir(repoRoot)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { features: [], skipped: [] }
    }
    throw err
  }

  const features: FeatureRecord[] = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(dir, entry)
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (err) {
      skipped.push({ path, reason: `read failed: ${(err as Error).message}` })
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (err) {
      skipped.push({ path, reason: `invalid JSON: ${(err as Error).message}` })
      logger.warn(`Skipping malformed feature file at ${path}: ${(err as Error).message}`)
      continue
    }
    const parsed = FeatureRecordSchema.safeParse(json)
    if (!parsed.success) {
      skipped.push({ path, reason: parsed.error.issues.map((i) => i.message).join('; ') })
      logger.warn(`Skipping feature ${path}: schema mismatch (${parsed.error.issues[0]?.message ?? 'unknown'})`)
      continue
    }
    // Surface — but tolerate — schema-version skew with upstream clawpatch.
    if (parsed.data.schemaVersion !== SUPPORTED_FEATURE_SCHEMA_VERSION) {
      logger.warn(
        `Feature ${parsed.data.featureId} uses clawpatch schemaVersion=${parsed.data.schemaVersion} ` +
          `(this build of kode-review supports ${SUPPORTED_FEATURE_SCHEMA_VERSION}). Proceeding; ` +
          `upgrade kode-review if the format has changed.`,
      )
    }
    features.push(parsed.data)
  }

  // Stable ordering — featureId is unique per clawpatch run, so this is
  // deterministic and avoids spurious diffs in test fixtures.
  features.sort((a, b) => a.featureId.localeCompare(b.featureId))
  return { features, skipped }
}

/**
 * Filter to features that haven't been reviewed yet in this kode-review run,
 * i.e. status is 'pending' or 'error' (the latter so we retry on re-run).
 *
 * Surfaces a visible warning for each 'error' feature so the user notices
 * persistent failures before they burn budget across many runs. A future
 * change can add a retry-count field to RepoFindingRecord and cap retries
 * after N attempts — for now, the visibility is the mitigation.
 */
export function pendingFeatures(features: FeatureRecord[]): FeatureRecord[] {
  const result: FeatureRecord[] = []
  for (const f of features) {
    if (f.status === 'pending') {
      result.push(f)
    } else if (f.status === 'error') {
      logger.warn(
        `Feature ${f.featureId} is in 'error' status; retrying. If this persists, ` +
          `the feature record may be malformed or the model may be timing out on it.`,
      )
      result.push(f)
    }
  }
  return result
}
