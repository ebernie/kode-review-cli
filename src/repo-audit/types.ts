/**
 * Types for `--scope repo` whole-codebase review.
 *
 * - FeatureRecord mirrors clawpatch's feature schema so we can parse
 *   `.clawpatch/features/*.json` directly. Read-only consumer: we never
 *   write into `.clawpatch/`.
 * - RepoFindingRecord is kode-review's canonical per-finding record stored
 *   in `.kode-review/findings/<id>.json`. Wraps the existing `Finding` shape
 *   with lifecycle + provenance fields so `--revalidate` can update it.
 */
import { z } from 'zod'
import { FindingSchema, type Finding } from '../review/finding-schema.js'

// ── clawpatch feature schema mirror ───────────────────────────────────────

export const FEATURE_KINDS = [
  'cli-command',
  'route',
  'ui-flow',
  'service',
  'job',
  'agent-tool',
  'library',
  'config',
  'release',
  'test-suite',
  'infra',
  'unknown',
] as const

export const FEATURE_STATUSES = [
  'pending',
  'claimed',
  'reviewed',
  'needs-fix',
  'fixing',
  'fixed',
  'revalidated',
  'skipped',
  'error',
] as const

export const TRUST_BOUNDARIES = [
  'user-input',
  'network',
  'filesystem',
  'secrets',
  'process-exec',
  'database',
  'auth',
  'permissions',
  'concurrency',
  'external-api',
  'serialization',
] as const

const FileRefSchema = z.object({
  path: z.string(),
  reason: z.string(),
})

const EntrypointSchema = z.object({
  path: z.string(),
  symbol: z.string().nullable(),
  route: z.string().nullable(),
  command: z.string().nullable(),
})

const TestRefSchema = z.object({
  path: z.string(),
  command: z.string().nullable(),
})

/** Latest clawpatch feature-record schema version this parser knows about. */
export const SUPPORTED_FEATURE_SCHEMA_VERSION = 1

/**
 * Subset of clawpatch's featureRecordSchema covering the fields kode-review
 * needs to drive a review. Extra fields in the source JSON are ignored.
 *
 * `schemaVersion` is validated as a positive integer (not pinned to a literal)
 * so the caller can decide whether to skip-with-warning or fail-hard on a
 * future schema bump. The array fields have `.default([])` as a forward-compat
 * cushion: clawpatch currently always emits them, but if a future version drops
 * an empty field we'd rather degrade gracefully than abort the whole run.
 */
export const FeatureRecordSchema = z.object({
  schemaVersion: z.number().int().positive(),
  featureId: z.string(),
  title: z.string(),
  summary: z.string(),
  kind: z.enum(FEATURE_KINDS),
  source: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  entrypoints: z.array(EntrypointSchema).default([]),
  ownedFiles: z.array(FileRefSchema).default([]),
  contextFiles: z.array(FileRefSchema).default([]),
  tests: z.array(TestRefSchema).default([]),
  tags: z.array(z.string()).default([]),
  trustBoundaries: z.array(z.enum(TRUST_BOUNDARIES)).default([]),
  status: z.enum(FEATURE_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type FeatureRecord = z.infer<typeof FeatureRecordSchema>
export type FeatureKind = (typeof FEATURE_KINDS)[number]
export type TrustBoundary = (typeof TRUST_BOUNDARIES)[number]

// ── kode-review's canonical per-finding record ────────────────────────────

export const REPO_FINDING_STATUSES = [
  'open',
  'false-positive',
  'fixed',
  'wont-fix',
  'uncertain',
] as const

export type RepoFindingStatus = (typeof REPO_FINDING_STATUSES)[number]

/**
 * Persisted in `.kode-review/findings/<findingId>.json`.
 *
 * `finding` is the verbatim parsed `Finding` from the LLM. The wrapper adds:
 *   - findingId: stable id (sha1 of feature + file + line + title) so we can
 *     look it up across runs without duplicates.
 *   - featureId: which feature this came from.
 *   - status: lifecycle state, updated by `--revalidate`.
 *   - createdAt / updatedAt: ISO timestamps.
 *   - createdByRunId: the run that emitted this finding (for tracing).
 *   - persona: which reviewer persona produced it.
 */
export const RepoFindingRecordSchema = z.object({
  schemaVersion: z.literal(1),
  findingId: z.string(),
  featureId: z.string(),
  persona: z.string(),
  status: z.enum(REPO_FINDING_STATUSES).default('open'),
  finding: FindingSchema,
  createdByRunId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type RepoFindingRecord = z.infer<typeof RepoFindingRecordSchema>

export type { Finding }

// ── repo-audit run options ────────────────────────────────────────────────

export type RepoAuditEngine = 'kode-agent' | 'clawpatch'

export interface RepoAuditOptions {
  /** Repository root (absolute). */
  repoRoot: string
  /** 'kode-agent' (default, uses our agentic engine) or 'clawpatch' (escape hatch). */
  engine: RepoAuditEngine
  /** Force re-map: pass `--force` to clawpatch map. */
  remap: boolean
  /** Worker concurrency. */
  jobs: number
  /** Filter feature set to those whose owned files changed since this git ref. */
  since?: string
  /** Skip review; only render findings already on disk. */
  reportOnly: boolean
  /** Re-check open findings against current code (no fresh review). */
  revalidate: boolean
  /** Mirror findings to `.clawpatch/findings/` in clawpatch schema. */
  clawpatchCompat: boolean
  /** Honor `kode-review: ignore` markers in source files. */
  suppressions: boolean
  /** Pass-through model name (forwarded to pi via clawpatch when engine === 'clawpatch'). */
  model?: string
  /** Reviewer personas to force. Empty array => auto-dispatch from trustBoundaries. */
  reviewerOverride: string[]
  /** Run id for this invocation; used as createdByRunId on new findings. */
  runId: string
  /** Quiet mode propagated from CLI. */
  quiet: boolean
}

/** Internal default values. Caps mirror clawpatch's. */
export const REPO_AUDIT_DEFAULTS = {
  MAX_OWNED_FILES_IN_PROMPT: 12,
  MAX_CONTEXT_FILES_IN_PROMPT: 24,
  MAX_FINDINGS_PER_FEATURE: 10,
  DEFAULT_JOBS: 4,
} as const
