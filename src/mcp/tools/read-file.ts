/**
 * MCP Tool: read_file
 *
 * Reads file content from the repository, with line limiting to prevent
 * overwhelming the context.
 */

import { readFile, realpath } from 'node:fs/promises'
import { join, isAbsolute, resolve, relative, sep } from 'node:path'

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
 * Check if a path matches sensitive file patterns
 */
function isSensitivePath(relativePath: string): boolean {
  // Normalize path separators for consistent matching
  const normalizedPath = relativePath.split(sep).join('/')
  const pathParts = normalizedPath.split('/')

  for (const part of pathParts) {
    // Check allowlist first - these are safe to read
    if (SAFE_PATTERNS.includes(part)) {
      continue
    }

    // Check for exact matches with sensitive patterns
    for (const pattern of SENSITIVE_PATTERNS) {
      if (part === pattern) {
        return true
      }
      // For .env, also block .env.* variants (except allowlisted ones)
      if (pattern === '.env' && part.startsWith('.env.') && !SAFE_PATTERNS.includes(part)) {
        return true
      }
    }

    // Check for Spring Boot profile-specific config files (application-{profile}.properties/yml/yaml)
    if (SPRING_PROFILE_PATTERN.test(part)) {
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
 */
export async function readFileHandler(
  input: ReadFileInput,
  repoRoot: string
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

  // Security check: block access to sensitive files/directories
  if (isSensitivePath(relativePath)) {
    throw new Error(`Access denied: "${input.path}" matches a sensitive file pattern (.git, .env, etc.)`)
  }

  // Additional security: resolve symlinks and check again
  // This prevents symlink attacks where a symlink in the repo points outside
  try {
    const realFilePath = await realpath(filePath)
    const realRepoRoot = await realpath(normalizedRepoRoot)
    const realRelativePath = relative(realRepoRoot, realFilePath)

    if (realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) {
      throw new Error(`Path traversal detected: ${input.path} resolves to symlink outside repository root`)
    }
  } catch (error) {
    // If realpath fails, the file doesn't exist - let it fail at readFile
    // But don't throw the security error for non-existent files
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  // Read the file
  const content = await readFile(filePath, 'utf-8')
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
