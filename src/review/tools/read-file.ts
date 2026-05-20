/**
 * MCP Tool: read_file
 *
 * Reads file content from the repository, with line limiting to prevent
 * overwhelming the context.
 */

import { readFile, realpath } from 'node:fs/promises'
import { join, isAbsolute, resolve, relative, sep } from 'node:path'
import type { Ignore } from 'ignore'

/**
 * Patterns for sensitive files/directories that should not be readable
 * These could contain secrets, credentials, or other sensitive data
 */
const SENSITIVE_PATTERNS = [
  // Git internals (may contain credentials in config)
  '.git',
  // Environment files (secrets, API keys)
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  // SSH keys
  '.ssh',
  // AWS credentials
  '.aws',
  // Private keys
  '.pem',
  // GPG keys
  '.gnupg',
  // Docker secrets
  '.docker',
  // NPM tokens
  '.npmrc',
  // PyPI tokens
  '.pypirc',
  // Java/Spring Boot config files (often contain DB credentials, API keys)
  'application.properties',
  'application.yml',
  'application.yaml',
]

/**
 * Patterns for Java/Spring Boot profile-specific config files
 * These match application-{profile}.properties/yml/yaml
 */
const SPRING_PROFILE_PATTERN = /^application-[\w-]+\.(properties|ya?ml)$/

/**
 * Allowlisted patterns that look sensitive but are safe to read
 * These are typically example/template files
 */
const SAFE_PATTERNS = [
  '.env.example',
  '.env.sample',
  '.env.template',
]

/**
 * Extension-based denylist for cryptographic key / certificate files.
 * Matched case-insensitively against the basename's suffix. `.pub` files
 * (public-key counterparts) are explicitly exempted by the caller.
 */
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.crt', '.cer']

/**
 * Exact-basename denylist for SSH private keys. These do not carry an
 * extension, so we match the file name verbatim.
 */
const SSH_PRIVATE_KEY_BASENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']

/**
 * GCP / generic service-account credential file basenames. Matches
 * service-account.json, my-service_account.json, etc.
 */
const SERVICE_ACCOUNT_PATTERN = /(^|[-_.])service[-_]?account.*\.json$/i

/**
 * Generic "credentials.json" / "credential.json" file basenames as used by
 * gcloud and various OAuth client libraries.
 */
const GCP_CREDENTIAL_PATTERN = /(^|[-_.])credentials?\.json$/i

/**
 * Check if a path matches sensitive file patterns.
 *
 * Exported so other tool handlers (search_code, future read-only tools) can
 * apply the same denylist before exposing file contents to the model.
 */
export function isSensitivePath(relativePath: string): boolean {
  // Normalize path separators for consistent matching
  const normalizedPath = relativePath.split(sep).join('/')
  const pathParts = normalizedPath.split('/')

  for (const part of pathParts) {
    // Lowercase the path component once. Case-insensitive matching is
    // required because (a) macOS HFS+ is case-insensitive and an
    // attacker-renamed `.ENV` resolves to `.env` on disk, and (b) an
    // indexer running on a Linux container may store paths with original
    // casing that still need to be denied on a case-insensitive client.
    // The denylist patterns themselves are all-lowercase by convention.
    const lowerPart = part.toLowerCase()

    // Check allowlist first - these are safe to read
    if (SAFE_PATTERNS.includes(lowerPart)) {
      continue
    }

    // Check for exact matches with sensitive patterns
    for (const pattern of SENSITIVE_PATTERNS) {
      if (lowerPart === pattern) {
        return true
      }
      // For .env, also block .env.* variants (except allowlisted ones)
      if (
        pattern === '.env' &&
        lowerPart.startsWith('.env.') &&
        !SAFE_PATTERNS.includes(lowerPart)
      ) {
        return true
      }
    }

    // Check for Spring Boot profile-specific config files (application-{profile}.properties/yml/yaml)
    if (SPRING_PROFILE_PATTERN.test(lowerPart)) {
      return true
    }

    // Extension-based check for cryptographic key / certificate files.
    // Public-key counterparts (*.pub) are safe to share, so exempt them.
    if (!lowerPart.endsWith('.pub')) {
      for (const ext of SENSITIVE_EXTENSIONS) {
        if (lowerPart.endsWith(ext)) {
          return true
        }
      }
    }

    // Exact-basename match for SSH private keys (no extension).
    if (SSH_PRIVATE_KEY_BASENAMES.includes(lowerPart)) {
      return true
    }

    // Service-account / credentials JSON files (GCP and generic OAuth).
    if (SERVICE_ACCOUNT_PATTERN.test(part) || GCP_CREDENTIAL_PATTERN.test(part)) {
      return true
    }
  }

  return false
}

export interface ReadFileInput {
  path: string
  startLine?: number
  maxLines?: number
}

export interface ReadFileOutput {
  content: string
  path: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
}

const DEFAULT_MAX_LINES = 500
const ABSOLUTE_MAX_LINES = 1000

/**
 * Read a file from the repository with line limiting
 *
 * @param input - The input parameters (path, startLine, maxLines)
 * @param repoRoot - The repository root directory
 * @param gitignore - Optional ignore instance for filtering gitignored files
 */
export async function readFileHandler(
  input: ReadFileInput,
  repoRoot: string,
  gitignore?: Ignore
): Promise<ReadFileOutput> {
  // Validate and normalize the path using secure approach
  let filePath = input.path

  // Normalize the repo root to ensure consistent comparison
  const normalizedRepoRoot = resolve(repoRoot)

  // Convert to absolute path if relative
  if (!isAbsolute(filePath)) {
    filePath = join(normalizedRepoRoot, filePath)
  }

  // Resolve to canonical path (handles .., ., and normalizes separators)
  filePath = resolve(filePath)

  // Security check using relative path - if it starts with .. or is absolute,
  // it's outside the repo root
  const relativePath = relative(normalizedRepoRoot, filePath)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Path traversal detected: ${input.path} resolves outside repository root`)
  }

  // First-pass security check on the requested (pre-realpath) path. This
  // catches the common case where the user directly names a sensitive file.
  if (isSensitivePath(relativePath)) {
    throw new Error(`Access denied: "${input.path}" matches a sensitive file pattern (.git, .env, etc.)`)
  }

  // Check if file is gitignored (prevents reading build artifacts, node_modules, etc.)
  if (gitignore && gitignore.ignores(relativePath)) {
    throw new Error(`Access denied: "${input.path}" is in .gitignore (build artifacts, dependencies, etc. are not readable)`)
  }

  // Resolve symlinks and re-run every security check against the canonical
  // path. This closes the symlink-bypass hole where e.g. notes.md -> .env
  // would pass the first-pass check but read secrets. We also read from the
  // canonical path below to close the TOCTOU window between checks and read.
  let canonicalReadPath = filePath
  try {
    const realFilePath = await realpath(filePath)
    const realRepoRoot = await realpath(normalizedRepoRoot)
    const realRelativePath = relative(realRepoRoot, realFilePath)

    if (realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) {
      throw new Error(`Path traversal detected: ${input.path} resolves to symlink outside repository root`)
    }

    if (isSensitivePath(realRelativePath)) {
      throw new Error(`Access denied: "${input.path}" is a symlink to a sensitive file`)
    }

    if (gitignore && gitignore.ignores(realRelativePath)) {
      throw new Error(`Access denied: "${input.path}" is a symlink to a gitignored path`)
    }

    canonicalReadPath = realFilePath
  } catch (error) {
    // If realpath fails because the file doesn't exist, fall through and let
    // readFile produce the canonical ENOENT. Any other realpath failure
    // (EACCES, ELOOP) or one of the security errors thrown above must
    // propagate.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  // Read the canonical (post-realpath) path so that nothing the security
  // checks just approved can be swapped underneath us before this call.
  const content = await readFile(canonicalReadPath, 'utf-8')
  const lines = content.split('\n')
  const totalLines = lines.length

  // Apply line limiting
  const startLine = Math.max(1, input.startLine ?? 1)
  const maxLines = Math.min(
    input.maxLines ?? DEFAULT_MAX_LINES,
    ABSOLUTE_MAX_LINES
  )

  const endIndex = Math.min(startLine - 1 + maxLines, totalLines)
  const selectedLines = lines.slice(startLine - 1, endIndex)
  const truncated = endIndex < totalLines

  // Add line numbers for context
  const numberedContent = selectedLines
    .map((line, idx) => `${startLine + idx}: ${line}`)
    .join('\n')

  return {
    content: numberedContent,
    path: input.path,
    startLine,
    endLine: startLine + selectedLines.length - 1,
    totalLines,
    truncated,
  }
}

/**
 * Tool schema for MCP registration
 */
export const readFileSchema = {
  name: 'read_file',
  description: 'Read file content from the repository. Returns file contents with line numbers. Use for examining specific files mentioned in the diff or related to the changes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (relative to repository root or absolute)',
      },
      startLine: {
        type: 'number',
        description: 'Starting line number (1-based, default: 1)',
      },
      maxLines: {
        type: 'number',
        description: `Maximum lines to return (default: ${DEFAULT_MAX_LINES}, max: ${ABSOLUTE_MAX_LINES})`,
      },
    },
    required: ['path'],
  },
}
