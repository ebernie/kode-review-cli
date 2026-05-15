import { describe, it, expect } from 'vitest'
import { shouldEnforceOnboardingGate } from '../gate.js'

describe('shouldEnforceOnboardingGate', () => {
  it('enforces the gate when onboarding is incomplete and --ci is off', () => {
    expect(shouldEnforceOnboardingGate({ ci: false }, false)).toBe(true)
  })

  it('skips the gate in --ci mode even when onboarding is incomplete', () => {
    // CI runs supply creds via env vars; the wizard is meaningless and there
    // is no terminal to host it. Regression guard for the bug where CI runs
    // hard-errored with "Configuration not found".
    expect(shouldEnforceOnboardingGate({ ci: true }, false)).toBe(false)
  })

  it('skips the gate when onboarding is already complete (interactive)', () => {
    expect(shouldEnforceOnboardingGate({ ci: false }, true)).toBe(false)
  })

  it('skips the gate when both onboarding is complete and --ci is on', () => {
    expect(shouldEnforceOnboardingGate({ ci: true }, true)).toBe(false)
  })
})
