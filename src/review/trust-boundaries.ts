/**
 * Lightweight path-based trust-boundary classifier.
 *
 * Inspired by clawpatch's per-feature trustBoundaries field but implemented
 * as a path-pattern heuristic (no AST, no framework parsing). The output is
 * injected into the review prompt so the LLM knows which boundaries the
 * changed files cross, and scopes findings accordingly.
 */

export const TRUST_BOUNDARIES = [
  'network',
  'user-input',
  'database',
  'secrets',
  'auth',
  'permissions',
  'process-exec',
  'filesystem',
  'serialization',
  'external-api',
] as const

export type TrustBoundary = (typeof TRUST_BOUNDARIES)[number]

interface Rule {
  re: RegExp
  boundaries: TrustBoundary[]
}

const RULES: Rule[] = [
  // Network entrypoints — routes/controllers/handlers/api → network + user-input
  { re: /(^|\/)(routes?|controllers?|handlers?|api|endpoints?)\//i, boundaries: ['network', 'user-input'] },
  { re: /\/route\.(t|j)sx?$/i, boundaries: ['network', 'user-input'] },
  { re: /\/(webhook|callback)s?\//i, boundaries: ['network', 'user-input'] },
  // Auth / session / crypto / secrets
  { re: /(^|\/)(auth|session|oauth|saml|sso)(\/|\.)/i, boundaries: ['auth', 'secrets'] },
  { re: /(^|\/)(crypto|jwt|token|secret|password|credential)s?(\/|\.)/i, boundaries: ['secrets'] },
  { re: /(^|\/)permissions?(\/|\.)/i, boundaries: ['permissions', 'auth'] },
  // Database
  { re: /(^|\/)(db|database|models?|repositor(y|ies)|migrations?|schema)(\/|\.)/i, boundaries: ['database'] },
  { re: /\.(sql|prisma)$/i, boundaries: ['database'] },
  // Process exec
  { re: /(^|\/)(exec|shell|subprocess|spawn)(\/|\.)/i, boundaries: ['process-exec'] },
  // Filesystem helpers
  { re: /(^|\/)(fs|filesystem|storage|uploads?)(\/|\.)/i, boundaries: ['filesystem'] },
  // Serialization / parsers
  { re: /(^|\/)(serializ|deserializ|parser|marshal|unmarshal)/i, boundaries: ['serialization'] },
  // External API / clients
  { re: /(^|\/)(client|sdk|integration)s?\//i, boundaries: ['external-api'] },
]

export function classifyTrustBoundaries(path: string): TrustBoundary[] {
  const hits = new Set<TrustBoundary>()
  for (const rule of RULES) {
    if (rule.re.test(path)) {
      for (const b of rule.boundaries) hits.add(b)
    }
  }
  return [...hits]
}

export function summarizeBoundariesForFiles(paths: string[]): Map<TrustBoundary, string[]> {
  const summary = new Map<TrustBoundary, string[]>()
  for (const p of paths) {
    for (const b of classifyTrustBoundaries(p)) {
      const existing = summary.get(b) ?? []
      existing.push(p)
      summary.set(b, existing)
    }
  }
  return summary
}
