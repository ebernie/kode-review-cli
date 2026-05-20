/**
 * Regression test for the indexer-status compose-file fix.
 *
 * Background: `isIndexerRunning` and `getIndexerStatus` previously called
 * `docker compose -p <project> ...` directly. Without `-f <compose.yaml>`
 * (and a matching `cwd`), `docker compose` can't find the compose file when
 * the caller is outside the indexer config directory — so the status check
 * incorrectly reports "not running" and triggers restarts / context skips.
 *
 * The fix routes both through the shared `dockerCompose` helper, which
 * injects `-f` + `cwd`. This test pins that invariant: a call to
 * `isIndexerRunning` must result in an `exec` invocation that includes
 * `-f .../compose.yaml`, regardless of the test's own cwd.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execCalls: Array<{ cmd: string; args: string[]; opts: any }> = []

vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(async (cmd: string, args: string[], opts?: any) => {
    execCalls.push({ cmd, args, opts: opts ?? {} })
    // Default: pretend `docker compose ps -q` returned no running containers.
    return { exitCode: 0, stdout: '', stderr: '' }
  }),
  execInteractive: vi.fn(async () => 0),
}))

vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { isIndexerRunning, getIndexerStatus } from '../docker.js'

beforeEach(() => {
  execCalls.length = 0
})

describe('isIndexerRunning / getIndexerStatus — compose file injection', () => {
  it('isIndexerRunning routes through dockerCompose (includes -f compose.yaml + cwd)', async () => {
    await isIndexerRunning()

    expect(execCalls.length).toBeGreaterThan(0)
    const call = execCalls[0]
    expect(call.cmd).toBe('docker')
    // Critical assertion: `-f <path>/compose.yaml` must be present so the
    // command works regardless of the test's own cwd. The previous bug was
    // exactly the absence of this flag.
    const fIdx = call.args.indexOf('-f')
    expect(fIdx).toBeGreaterThanOrEqual(0)
    expect(call.args[fIdx + 1]).toMatch(/compose\.yaml$/)
    // And dockerCompose passes its computed config dir as cwd.
    expect(typeof call.opts.cwd).toBe('string')
    expect(call.opts.cwd.length).toBeGreaterThan(0)
    // Subcommand stays `ps -q` — we only changed the routing.
    expect(call.args).toContain('ps')
    expect(call.args).toContain('-q')
  })

  it('getIndexerStatus initial ps call also includes -f compose.yaml', async () => {
    await getIndexerStatus()

    // Lock the assumption that getIndexerStatus makes exactly one `exec`
    // call (the JSON `ps`). The health check goes through IndexerClient
    // (HTTP), not exec. If a future refactor routes the health check
    // through exec, this `length === 1` assertion fails — preventing the
    // index-based [0] check below from silently asserting on the wrong call.
    expect(execCalls.length).toBe(1)
    const call = execCalls[0]
    expect(call.cmd).toBe('docker')
    const fIdx = call.args.indexOf('-f')
    expect(fIdx).toBeGreaterThanOrEqual(0)
    expect(call.args[fIdx + 1]).toMatch(/compose\.yaml$/)
    expect(call.args).toContain('ps')
    expect(call.args).toContain('--format')
    expect(call.args).toContain('json')
  })
})
