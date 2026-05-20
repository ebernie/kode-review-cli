/**
 * Strip ANSI/OSC escape sequences and control characters from text bound
 * for the user's terminal. Used on VCS-controlled display strings (PR/MR
 * titles, repository names) before they reach console.log, inquirer
 * prompts, or any path where the terminal interprets escape codes.
 *
 * Threat model: an attacker who controls a PR title (any contributor on
 * a public repo) inserts ANSI CSI/OSC sequences that:
 *   - clear the screen / move the cursor to spoof other output
 *   - rewrite previously-printed lines via cursor-up + erase-line
 *   - update OSC 52 ("manipulate clipboard")
 *   - corrupt log files captured from the terminal
 *
 * We keep printable text plus \t and \n. Everything else in the C0/C1
 * control ranges, plus any escape-introduced sequence, is removed.
 */

/**
 * Match (a) any ESC-introduced sequence — CSI, OSC, simple two-byte
 * escapes, and (b) terminated bare C1 CSI/OSC introducers (`\x9B` /
 * `\x9D`), so 8-bit encodings are caught too.
 *
 * Each top-level alternative:
 *  1. `\x1B[[0-?]*[ -/]*[@-~]`     — CSI: ESC `[` <params> <intermediate> <final>
 *  2. `\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)` — OSC: ESC `]` <data> <BEL|ST>
 *  3. `\x1B[@-Z\\\\-_]`            — single-byte escape sequence
 *  4. `\x9B[0-?]*[ -/]*[@-~]`      — 8-bit CSI introducer (U+009B)
 *  5. `\x9D[^\x07\x9C]*\x9C`       — 8-bit OSC introducer (U+009D) … ST
 *
 * Alternatives 2 and 5 only fire when their terminator is present. An
 * *un*terminated 7-bit OSC (`\x1B]…` without BEL/ST) leaves the ESC
 * byte behind — `C0_CTRL_RE` strips it on the next pass. An
 * *un*terminated 8-bit OSC (`\x9D…`) leaves the `\x9D` introducer
 * behind — `C1_CTRL_RE` strips it on the third pass. Without the
 * introducer byte, the surviving text is plain prose to the terminal:
 * even an 8-bit-capable VT220 won't enter OSC mode without `\x9D`
 * arriving first, so the residual payload renders as literal text.
 */
const ESC_SEQ_RE =
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\\-_]|\x9B[0-?]*[ -/]*[@-~]|\x9D[^\x07\x9C]*\x9C/g

/**
 * C0 controls (0x00–0x1F) and DEL (0x7F), except TAB (0x09) and LF (0x0A).
 * CR (0x0D) is included because it lets an attacker rewrite the current
 * line ("carriage return spoofing" in log captures).
 */
// eslint-disable-next-line no-control-regex
const C0_CTRL_RE = /[\x00-\x08\x0B-\x1F\x7F]/g

/**
 * C1 controls (0x80–0x9F). Latin-1 letters start at 0xA0, so this range
 * is exclusively control codes. (The no-control-regex rule only flags
 * C0/DEL ranges, so no disable directive is needed here.)
 */
const C1_CTRL_RE = /[\x80-\x9F]/g

/**
 * Sanitize an externally-supplied string for safe terminal rendering.
 *
 * Idempotent. Returns an empty string for nullish input rather than
 * propagating undefined into a template literal.
 */
export function sanitizeTerminalText(input: string | undefined | null): string {
  if (!input) return ''
  return input
    .replace(ESC_SEQ_RE, '')
    .replace(C0_CTRL_RE, '')
    .replace(C1_CTRL_RE, '')
}
