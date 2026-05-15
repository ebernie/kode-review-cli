/**
 * Decide whether the onboarding gate should block a review invocation.
 *
 * The gate is a UX nicety — it prompts incomplete users to run the wizard.
 * It is NOT an auth check; pi (https://pi.dev) reads credentials from env
 * vars and `~/.pi/agent/auth.json` regardless of this flag.
 *
 * `--ci` mode bypasses the gate: CI runs supply creds via env vars and
 * have no terminal to host the wizard. If creds are genuinely missing,
 * the review engine surfaces a clearer auth error itself.
 */
export function shouldEnforceOnboardingGate(
  opts: { ci: boolean },
  onboardingComplete: boolean,
): boolean {
  return !onboardingComplete && !opts.ci
}
