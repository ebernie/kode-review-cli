/**
 * Tests the shared sensitive-path filter applied by search_code,
 * find_definitions, and find_usages. The denylist itself lives in
 * read-file.ts and is exercised by read-file.test.ts; here we pin the
 * generic filter wiring: results with sensitive paths are dropped while
 * benign paths and edge-cases (empty input, paths with safe lookalikes)
 * survive.
 */

import { describe, it, expect } from 'vitest'
import { filterSensitivePaths, filterSensitivePathStrings } from '../sensitive-filter.js'

describe('filterSensitivePaths', () => {
  it('passes benign paths through unchanged', () => {
    const input = [
      { path: 'src/index.ts' },
      { path: 'lib/helpers.py' },
      { path: 'README.md' },
    ]
    expect(filterSensitivePaths(input)).toEqual(input)
  })

  it('drops .env results', () => {
    const out = filterSensitivePaths([
      { path: 'src/index.ts' },
      { path: '.env' },
      { path: '.env.local' },
      { path: '.env.production' },
    ])
    expect(out).toEqual([{ path: 'src/index.ts' }])
  })

  it('keeps .env.example, .env.sample, .env.template (safe allowlist)', () => {
    const out = filterSensitivePaths([
      { path: '.env.example' },
      { path: '.env.sample' },
      { path: '.env.template' },
    ])
    expect(out.map((r) => r.path)).toEqual([
      '.env.example',
      '.env.sample',
      '.env.template',
    ])
  })

  it('drops Spring Boot profile-specific configs', () => {
    const out = filterSensitivePaths([
      { path: 'src/main/resources/application-prod.yml' },
      { path: 'src/main/resources/application-dev.properties' },
      { path: 'src/main/resources/application-staging.yaml' },
      { path: 'README.md' },
    ])
    expect(out.map((r) => r.path)).toEqual(['README.md'])
  })

  it('drops cryptographic key/cert files by extension', () => {
    const out = filterSensitivePaths([
      { path: 'keys/server.pem' },
      { path: 'keys/server.key' },
      { path: 'keys/server.crt' },
      { path: 'keys/server.p12' },
      { path: 'src/index.ts' },
    ])
    expect(out.map((r) => r.path)).toEqual(['src/index.ts'])
  })

  it('keeps public-key counterparts (.pub) outside sensitive directories', () => {
    // The .pub exemption applies at the basename level, but the path
    // walker also checks each directory component. A .pub file inside
    // .ssh/ (e.g., `.ssh/id_rsa.pub`) is still filtered because the
    // .ssh segment is itself in the denylist. That's the documented
    // behavior — .ssh contents are considered sensitive as a whole.
    const out = filterSensitivePaths([
      { path: 'keys/server.pem.pub' },
      { path: 'src/types.pub' },
    ])
    expect(out.map((r) => r.path)).toEqual(['keys/server.pem.pub', 'src/types.pub'])
  })

  it('still filters .pub files inside .ssh (directory check fires first)', () => {
    const out = filterSensitivePaths([
      { path: '.ssh/id_rsa.pub' },
      { path: 'src/index.ts' },
    ])
    expect(out.map((r) => r.path)).toEqual(['src/index.ts'])
  })

  it('drops SSH private keys by exact basename', () => {
    const out = filterSensitivePaths([
      { path: 'home/user/.ssh/id_rsa' },
      { path: 'home/user/.ssh/id_ed25519' },
      { path: 'home/user/.ssh/id_ecdsa' },
      { path: 'home/user/.ssh/id_dsa' },
      { path: 'src/index.ts' },
    ])
    expect(out.map((r) => r.path)).toEqual(['src/index.ts'])
  })

  it('drops service-account and credentials JSON files', () => {
    const out = filterSensitivePaths([
      { path: 'auth/service-account.json' },
      { path: 'auth/my-service_account.json' },
      { path: 'auth/credentials.json' },
      { path: 'auth/credential.json' },
      { path: 'src/types.json' },
    ])
    expect(out.map((r) => r.path)).toEqual(['src/types.json'])
  })

  it('drops .git internals', () => {
    const out = filterSensitivePaths([
      { path: '.git/config' },
      { path: 'src/.git/HEAD' },
      { path: 'src/index.ts' },
    ])
    expect(out.map((r) => r.path)).toEqual(['src/index.ts'])
  })

  it('drops .ssh / .aws / .gnupg / .docker / .npmrc / .pypirc directory entries', () => {
    const sensitive = [
      'home/.ssh/known_hosts',
      'home/.aws/credentials',
      'home/.gnupg/secring.gpg',
      'home/.docker/config.json',
      'home/.npmrc',
      'home/.pypirc',
    ]
    const out = filterSensitivePaths([
      ...sensitive.map((path) => ({ path })),
      { path: 'src/index.ts' },
    ])
    expect(out.map((r) => r.path)).toEqual(['src/index.ts'])
  })

  it('preserves extra properties on each result (generic over T)', () => {
    const out = filterSensitivePaths([
      { path: 'src/index.ts', score: 0.9, matchTypes: ['lexical'] },
      { path: '.env', score: 0.8, matchTypes: ['lexical'] },
    ])
    expect(out).toEqual([
      { path: 'src/index.ts', score: 0.9, matchTypes: ['lexical'] },
    ])
  })

  it('returns an empty array for an empty input (no NPE on edge case)', () => {
    expect(filterSensitivePaths([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const input = [{ path: '.env' }, { path: 'src/index.ts' }]
    const snapshot = JSON.parse(JSON.stringify(input))
    filterSensitivePaths(input)
    expect(input).toEqual(snapshot)
  })

  it('matches the denylist case-insensitively', () => {
    // macOS HFS+ is case-insensitive: a file renamed `.ENV` resolves to
    // `.env` on disk. An indexer running on a Linux container may
    // surface either casing. The filter must catch both.
    const out = filterSensitivePaths([
      { path: '.ENV' },
      { path: '.Env.Production' },
      { path: 'CONFIG/APPLICATION-PROD.YML' },
      { path: 'keys/SERVER.PEM' },
      { path: 'src/index.ts' },
    ])
    expect(out.map((r) => r.path)).toEqual(['src/index.ts'])
  })

  it('preserves case in the surviving paths (lowercasing is only used for matching)', () => {
    // A regression that lowercased the *output* would mangle real paths.
    const out = filterSensitivePaths([
      { path: 'Src/MyComponent.tsx' },
      { path: '.env' },
    ])
    expect(out.map((r) => r.path)).toEqual(['Src/MyComponent.tsx'])
  })
})

describe('filterSensitivePathStrings', () => {
  it('passes benign paths through unchanged', () => {
    const out = filterSensitivePathStrings(['src/index.ts', 'lib/helpers.py', 'README.md'])
    expect(out).toEqual(['src/index.ts', 'lib/helpers.py', 'README.md'])
  })

  it('drops sensitive paths', () => {
    const out = filterSensitivePathStrings([
      '.env',
      'src/app.ts',
      'config/application-prod.yml',
      'keys/server.pem',
      'auth/credentials.json',
    ])
    expect(out).toEqual(['src/app.ts'])
  })

  it('returns an empty array for empty input', () => {
    expect(filterSensitivePathStrings([])).toEqual([])
  })

  it('handles case-insensitive matching on bare strings too', () => {
    const out = filterSensitivePathStrings(['.ENV', 'KEYS/SERVER.PEM', 'src/app.ts'])
    expect(out).toEqual(['src/app.ts'])
  })

  it('does not mutate the input array', () => {
    const input = ['.env', 'src/index.ts']
    const snapshot = [...input]
    filterSensitivePathStrings(input)
    expect(input).toEqual(snapshot)
  })
})
