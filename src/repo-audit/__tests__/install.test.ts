/**
 * Tests for install.ts — package-manager detection, install hint text, and
 * the Node-version compatibility check.
 *
 * detectClawpatch() shells out and is exercised indirectly via the
 * onboarding integration test (later); here we focus on the pure logic.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the exec wrapper so detectClawpatch tests don't shell out.
const { commandExistsMock, execMock } = vi.hoisted(() => ({
  commandExistsMock: vi.fn(),
  execMock: vi.fn(),
}))
vi.mock('../../utils/exec.js', () => ({
  commandExists: commandExistsMock,
  exec: execMock,
}))

import {
  buildInstallHint,
  buildNodeUpgradeHint,
  detectClawpatch,
  detectPreferredPackageManager,
  isNodeVersionCompatible,
} from '../install.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-install-'))
  commandExistsMock.mockReset()
  execMock.mockReset()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('detectPreferredPackageManager', () => {
  it('returns bun when bun.lock exists', async () => {
    await writeFile(join(tmp, 'bun.lock'), '')
    expect(detectPreferredPackageManager(tmp)).toBe('bun')
  })

  it('returns bun when bun.lockb (binary lockfile) exists', async () => {
    await writeFile(join(tmp, 'bun.lockb'), '')
    expect(detectPreferredPackageManager(tmp)).toBe('bun')
  })

  it('returns pnpm when pnpm-lock.yaml exists', async () => {
    await writeFile(join(tmp, 'pnpm-lock.yaml'), '')
    expect(detectPreferredPackageManager(tmp)).toBe('pnpm')
  })

  it('returns yarn when yarn.lock exists', async () => {
    await writeFile(join(tmp, 'yarn.lock'), '')
    expect(detectPreferredPackageManager(tmp)).toBe('yarn')
  })

  it('returns npm when no recognized lockfile exists', () => {
    expect(detectPreferredPackageManager(tmp)).toBe('npm')
  })

  it('bun takes priority over pnpm when both lockfiles are present', async () => {
    // Edge case: a partially-migrated repo. The earlier check wins, which
    // matters because the hint should match the manager the user is
    // actively running.
    await writeFile(join(tmp, 'bun.lock'), '')
    await writeFile(join(tmp, 'pnpm-lock.yaml'), '')
    expect(detectPreferredPackageManager(tmp)).toBe('bun')
  })
})

describe('buildInstallHint', () => {
  it('puts the preferred manager first', async () => {
    await writeFile(join(tmp, 'bun.lock'), '')
    const hint = buildInstallHint(tmp)
    const bunIdx = hint.indexOf('bun add')
    const npmIdx = hint.indexOf('npm install')
    expect(bunIdx).toBeGreaterThan(-1)
    expect(npmIdx).toBeGreaterThan(-1)
    expect(bunIdx).toBeLessThan(npmIdx)
  })

  it('always offers npm as a universal fallback even when preferred is not npm', async () => {
    await writeFile(join(tmp, 'pnpm-lock.yaml'), '')
    expect(buildInstallHint(tmp)).toContain('npm install -g clawpatch')
  })

  it('does not duplicate npm when npm is the preferred manager', () => {
    // npm is preferred (no lockfile detected). The hint should not list
    // npm twice.
    const hint = buildInstallHint(tmp)
    const matches = hint.match(/npm install -g clawpatch/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('mentions the Node.js version requirement', () => {
    expect(buildInstallHint(tmp)).toMatch(/Node\.js >= \d+/)
  })

  it('includes npx as an ephemeral fallback', () => {
    expect(buildInstallHint(tmp)).toContain('npx clawpatch')
  })

  it('leads with a clear "not on PATH" diagnosis', () => {
    expect(buildInstallHint(tmp)).toMatch(/clawpatch is not on PATH/)
  })
})

describe('isNodeVersionCompatible', () => {
  it('returns true on Node >= 22 (must match the parsed process.version major)', () => {
    // The CI matrix runs on Node 22+; if we ever drop CI to 20 this asserts
    // the helper is honest about it. Either way, the boolean must match
    // what the helper parses from process.version.
    const match = process.version.match(/^v?(\d+)/)
    const major = match ? parseInt(match[1]!, 10) : 0
    expect(isNodeVersionCompatible()).toBe(major >= 22)
  })
})

describe('detectClawpatch', () => {
  it('returns { installed: false, version: null } when clawpatch is not on PATH', async () => {
    commandExistsMock.mockResolvedValue(false)
    const status = await detectClawpatch()
    expect(status).toEqual({ installed: false, version: null })
    expect(execMock).not.toHaveBeenCalled()
  })

  it('returns the parsed version when clawpatch is on PATH and --version succeeds', async () => {
    commandExistsMock.mockResolvedValue(true)
    execMock.mockResolvedValue({ stdout: 'clawpatch 0.3.0\n', stderr: '', exitCode: 0 })
    const status = await detectClawpatch()
    expect(status.installed).toBe(true)
    expect(status.version).toBe('clawpatch 0.3.0')
  })

  it('returns installed=true with null version if --version exits non-zero', async () => {
    commandExistsMock.mockResolvedValue(true)
    execMock.mockResolvedValue({ stdout: '', stderr: 'broken', exitCode: 1 })
    const status = await detectClawpatch()
    expect(status.installed).toBe(true)
    expect(status.version).toBeNull()
  })

  it('passes --version to the clawpatch binary', async () => {
    commandExistsMock.mockResolvedValue(true)
    execMock.mockResolvedValue({ stdout: 'x', stderr: '', exitCode: 0 })
    await detectClawpatch()
    expect(execMock).toHaveBeenCalledWith('clawpatch', ['--version'])
  })
})

describe('buildNodeUpgradeHint', () => {
  it('quotes the current process.version verbatim', () => {
    expect(buildNodeUpgradeHint()).toContain(process.version)
  })

  it('lists common Node version managers', () => {
    const hint = buildNodeUpgradeHint()
    expect(hint).toContain('nvm')
    expect(hint).toContain('fnm')
  })
})
