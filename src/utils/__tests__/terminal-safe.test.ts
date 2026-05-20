import { describe, it, expect } from 'vitest'
import { sanitizeTerminalText } from '../terminal-safe.js'

describe('sanitizeTerminalText', () => {
  it('returns an empty string for nullish input', () => {
    expect(sanitizeTerminalText(undefined)).toBe('')
    expect(sanitizeTerminalText(null)).toBe('')
    expect(sanitizeTerminalText('')).toBe('')
  })

  it('passes printable ASCII through unchanged', () => {
    const ascii = 'Update parser & fix bug (#123) -- handles "edge" cases'
    expect(sanitizeTerminalText(ascii)).toBe(ascii)
  })

  it('preserves tab and newline', () => {
    expect(sanitizeTerminalText('line1\nline2\tcol')).toBe('line1\nline2\tcol')
  })

  it('preserves emoji and Latin-1 supplement characters', () => {
    // Latin-1 supplement (0xA0+) and emoji (supplementary planes) must
    // survive — the C1 control range is exclusively 0x80-0x9F.
    const text = 'Café résumé 😀 — naïve'
    expect(sanitizeTerminalText(text)).toBe(text)
  })

  it('preserves U+00A0 (the boundary character just above the C1 range)', () => {
    // The SUT documents 0x9F as the last C1 control and 0xA0 as the
    // first safe Latin-1 character (non-breaking space). A one-off bug
    // in C1_CTRL_RE that extended the upper bound to 0xA0 would silently
    // strip NBSP from PR titles — pin the exact boundary value.
    expect(sanitizeTerminalText('no break')).toBe('no break')
  })

  it('strips ANSI CSI color codes', () => {
    // \x1B[31m = red, \x1B[0m = reset
    const malicious = '\x1B[31mFAKE ERROR\x1B[0m: please run rm -rf /'
    const out = sanitizeTerminalText(malicious)
    expect(out).toBe('FAKE ERROR: please run rm -rf /')
    expect(out).not.toContain('\x1B')
  })

  it('strips ANSI cursor-up + erase-line (line spoofing)', () => {
    // CR then \x1B[A (up) then \x1B[2K (erase line) lets an attacker
    // rewrite earlier output. We strip both ESC sequences AND the CR
    // (which alone allows in-line rewriting in many terminals).
    const malicious = 'innocent line\r\x1B[A\x1B[2KFAKE'
    const out = sanitizeTerminalText(malicious)
    expect(out).toBe('innocent lineFAKE')
    expect(out).not.toContain('\r')
    expect(out).not.toContain('\x1B')
  })

  it('strips OSC 52 (clipboard manipulation)', () => {
    // OSC 52 ; c ; <base64> BEL — used by some terminals to set the
    // system clipboard from terminal output.
    const malicious = 'title\x1B]52;c;cm0gLXJmIC8=\x07 suffix'
    const out = sanitizeTerminalText(malicious)
    expect(out).toBe('title suffix')
    expect(out).not.toContain('\x1B]')
  })

  it('strips OSC sequences terminated by ST (ESC backslash)', () => {
    const malicious = 'before\x1B]2;new-title\x1B\\after'
    const out = sanitizeTerminalText(malicious)
    expect(out).toBe('beforeafter')
  })

  it('strips bare C1 CSI sequences (8-bit ESC[ form)', () => {
    // U+009B is the 8-bit equivalent of ESC `[`. Some terminals honor it.
    const malicious = 'A\u009B31mRED\u009B0mB'
    const out = sanitizeTerminalText(malicious)
    expect(out).toBe('AREDB')
    expect(out).not.toContain('\u009B')
  })

  it('strips bare C1 OSC sequences terminated by ST (U+009C)', () => {
    // U+009D = 8-bit OSC introducer; U+009C = ST.
    const malicious = 'before\u009D2;evil-title\u009Cafter'
    const out = sanitizeTerminalText(malicious)
    expect(out).toBe('beforeafter')
    expect(out).not.toContain('\u009D')
    expect(out).not.toContain('\u009C')
  })

  it('strips an unterminated 8-bit OSC introducer (no ST) via the C1 fallback', () => {
    // The ESC_SEQ_RE 8-bit OSC alternative requires `\u009C`. Without
    // it, that alternative doesn't match. The C1_CTRL_RE pass then
    // strips the bare `\u009D` introducer. The payload bytes that
    // followed it remain \u2014 but without the introducer the terminal
    // sees plain text, not an OSC sequence.
    const out = sanitizeTerminalText('safe \u009D2;no-terminator payload')
    expect(out).toBe('safe 2;no-terminator payload')
    expect(out).not.toContain('\u009D')
  })

  it('strips an unterminated 7-bit OSC introducer (no BEL/ST) via the C0 fallback', () => {
    // Same shape as above, but 7-bit. The ESC_SEQ_RE 7-bit OSC
    // alternative needs BEL or ESC-backslash. Without it, C0_CTRL_RE
    // strips the lone ESC byte.
    const out = sanitizeTerminalText('safe \x1B]2;no-terminator payload')
    expect(out).toBe('safe ]2;no-terminator payload')
    expect(out).not.toContain('\x1B')
  })

  it('strips C0 controls except tab and newline', () => {
    const text = 'a\x00b\x07c\x08d\x0Ee\x1Ff'
    expect(sanitizeTerminalText(text)).toBe('abcdef')
  })

  it('strips DEL (0x7F)', () => {
    expect(sanitizeTerminalText('a\x7Fb')).toBe('ab')
  })

  it('is idempotent: sanitizing a clean string is a no-op', () => {
    const clean = 'a clean PR title with — em-dash and 🎉'
    expect(sanitizeTerminalText(sanitizeTerminalText(clean))).toBe(clean)
  })

  it('is idempotent against a malicious payload', () => {
    // A second pass over the already-sanitized output must not produce
    // a different result. The ordering of replace calls (ESC-seq → C0 →
    // C1) makes this safe today; this test guards against a future
    // regex reordering that could leave partial-match leftovers.
    const malicious = '\x1B[31mevil\x07\x1B]52;c;data\x07\x9B0m\x9D2;t\x9C'
    const once = sanitizeTerminalText(malicious)
    expect(sanitizeTerminalText(once)).toBe(once)
  })

  it('strips a screen-clear sequence buried in the middle of a title', () => {
    // \x1B[2J = clear entire screen. Anchors the most damaging payload
    // shape: it appears mid-string with otherwise-clean text around it.
    const malicious = 'Refactor parser\x1B[2J for clarity'
    const out = sanitizeTerminalText(malicious)
    expect(out).toBe('Refactor parser for clarity')
  })
})
