/**
 * Classify model-side errors so the orchestrator can decide whether to
 * continue with the next persona/feature, break the loop early, or surface
 * the failure as terminal.
 *
 * Pattern-based on the error message because pi exposes upstream provider
 * errors as plain `Error` instances without status codes. We accept some
 * fuzziness here: false negatives mean the loop aborts on a recoverable
 * error (annoying but safe); false positives mean we keep churning through
 * a real rate-limit (the next call hits the same wall and we abort then).
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate[\s-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /quota.*exceeded/i,
]

const TIMEOUT_PATTERNS: RegExp[] = [
  /did not complete within/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bsocket hang up\b/i,
]

function messageOf(err: unknown): string {
  if (err === null || err === undefined) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return String(err)
}

export function isRateLimitError(err: unknown): boolean {
  const msg = messageOf(err)
  if (msg.length === 0) return false
  return RATE_LIMIT_PATTERNS.some((re) => re.test(msg))
}

export function isTransientModelError(err: unknown): boolean {
  if (isRateLimitError(err)) return true
  const msg = messageOf(err)
  if (msg.length === 0) return false
  return TIMEOUT_PATTERNS.some((re) => re.test(msg))
}
