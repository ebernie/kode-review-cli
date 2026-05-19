/**
 * Trust-boundary-driven persona dispatch for repo-scope review.
 *
 * Each feature's `trustBoundaries` + `kind` determine which reviewer
 * personas should examine it. Internal helper packages with no security
 * surface don't trigger the security persona; framework code with a heavy
 * external surface does.
 *
 * Rules (in order; a persona is included if ANY rule matches it):
 *
 *   Trust boundary                                  → Persona auto-included
 *   ────────────────────────────────────────────────────────────────────────
 *   user-input / network / serialization /            security
 *   external-api / auth / permissions / secrets
 *
 *   (always)                                          general
 *
 *   kind ∈ {package*, library, service}               architect
 *   (* kind 'package' is not part of clawpatch's
 *      enum — see types.ts; library/service approximate)
 *
 *   kind === 'test-suite' OR tests.length > 0         test-auditor
 *
 *   doc-reviewer is NEVER auto-included; only if the
 *   user passes --reviewer doc-reviewer explicitly.
 *
 * Output preserves the order: general → architect → security → test-auditor.
 * This is the order downstream rendering uses to group findings.
 */
import type { BuiltinReviewerName } from '../reviewers/registry.js'
import type { FeatureRecord, TrustBoundary } from './types.js'

/**
 * Trust boundaries that auto-include the security persona. Deliberately
 * EXCLUDES filesystem / database / process-exec / concurrency — those alone
 * are not a security surface (every backend touches the filesystem) and
 * including them would fire the security persona on every internal helper.
 *
 * The general persona still flags filesystem-only path-traversal / TOCTOU
 * bugs; this set is for *amplifying* security coverage where it pays off
 * (external attack surfaces, authn/authz, secrets).
 */
const SECURITY_BOUNDARIES = new Set<TrustBoundary>([
  'user-input',
  'network',
  'serialization',
  'external-api',
  'auth',
  'permissions',
  'secrets',
])

const ARCHITECT_KINDS = new Set<FeatureRecord['kind']>(['library', 'service'])

/**
 * Pick the personas that should review the given feature. Stable order:
 * general first, then architect/security/test-auditor.
 *
 * `doc-reviewer` is intentionally never auto-included: doc review on every
 * feature is noisy at repo scale. Callers who want it pass it explicitly.
 */
export function selectPersonas(feature: FeatureRecord): BuiltinReviewerName[] {
  const personas: BuiltinReviewerName[] = ['general']

  if (ARCHITECT_KINDS.has(feature.kind)) {
    personas.push('architect')
  }

  if (feature.trustBoundaries.some((b) => SECURITY_BOUNDARIES.has(b))) {
    personas.push('security')
  }

  if (feature.kind === 'test-suite' || feature.tests.length > 0) {
    personas.push('test-auditor')
  }

  return personas
}

/**
 * Apply a user override (from `--reviewer …`) on top of auto-dispatch.
 *
 * - Empty override array → use auto-dispatch.
 * - Non-empty override   → use the override verbatim (deduplicated, in order).
 *   This preserves the existing `--reviewer all` / `--reviewer security` UX
 *   for users who want explicit control on a repo-scope run.
 */
export function resolvePersonasWithOverride(
  feature: FeatureRecord,
  overrideNames: string[],
): string[] {
  if (overrideNames.length === 0) return selectPersonas(feature)
  // Preserve order, deduplicate.
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of overrideNames) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}
