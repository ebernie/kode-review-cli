/**
 * Project structure context module
 * Generates condensed directory tree and extracts project documentation
 */

import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { exec } from '../utils/exec.js'
import { logger } from '../utils/logger.js'

/**
 * Maximum number of lines for the directory tree
 */
const MAX_TREE_LINES = 50

/**
 * Maximum characters to extract from README files
 */
const README_MAX_CHARS = 500

/**
 * Files to check for architecture documentation
 */
const ARCHITECTURE_FILES = [
  'ARCHITECTURE.md',
  'architecture.md',
  'DESIGN.md',
  'design.md',
  'STRUCTURE.md',
  'structure.md',
  'docs/ARCHITECTURE.md',
  'docs/architecture.md',
  'docs/DESIGN.md',
  'docs/design.md',
]

/**
 * README file patterns (in order of preference)
 */
const README_FILES = ['README.md', 'readme.md', 'Readme.md', 'README.txt', 'readme.txt']

/**
 * Directories to always exclude from tree
 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'venv',
  '.venv',
  'env',
  '.env',
  'vendor',
  '.idea',
  '.vscode',
  '.cache',
  'target', // Rust/Java
  'Pods', // iOS
])

/**
 * File patterns to exclude from tree
 */
const EXCLUDED_FILE_PATTERNS = [/^\.DS_Store$/, /^Thumbs\.db$/, /\.pyc$/, /\.pyo$/]

export interface ProjectStructureContext {
  /** Condensed directory tree (max 50 lines) */
  directoryTree: string
  /** README.md summary (first 500 chars) if present */
  readmeSummary?: string
  /** ARCHITECTURE.md content if present */
  architectureDoc?: string
}

interface TreeNode {
  name: string
  isDirectory: boolean
  children?: TreeNode[]
  isHighlighted?: boolean
}

/**
 * Check if a path should be excluded from the tree
 */
function shouldExclude(name: string, isDirectory: boolean): boolean {
  if (isDirectory && EXCLUDED_DIRS.has(name)) {
    return true
  }

  if (!isDirectory) {
    for (const pattern of EXCLUDED_FILE_PATTERNS) {
      if (pattern.test(name)) {
        return true
      }
    }
  }

  return false
}

/**
 * Build a tree structure from the repository, respecting .gitignore
 * Uses git ls-files for safe execution (no shell injection via execa with args array)
 */
async function buildTree(repoRoot: string, maxDepth: number = 4): Promise<TreeNode> {
  // Use git ls-files to get tracked files (respects .gitignore)
  // exec() from utils/exec.js uses execa with args array - safe against injection
  const result = await exec('git', ['ls-files', '--full-name'], { cwd: repoRoot })

  const files: string[] = []

  if (result.exitCode === 0 && result.stdout.trim()) {
    files.push(...result.stdout.trim().split('\n').filter(Boolean))
  }

  // Also get untracked files that aren't ignored
  const untrackedResult = await exec('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: repoRoot,
  })
  if (untrackedResult.exitCode === 0 && untrackedResult.stdout.trim()) {
    files.push(...untrackedResult.stdout.trim().split('\n').filter(Boolean))
  }

  // Build tree from file paths
  const root: TreeNode = {
    name: basename(repoRoot),
    isDirectory: true,
    children: [],
  }

  const dirMap = new Map<string, TreeNode>()
  dirMap.set('', root)

  for (const filePath of files) {
    const parts = filePath.split('/')
    let currentPath = ''

    // Process directory parts
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      const parentPath = currentPath
      currentPath = currentPath ? `${currentPath}/${part}` : part

      // Check depth limit
      if (i >= maxDepth) break

      // Skip excluded directories
      if (shouldExclude(part, true)) break

      if (!dirMap.has(currentPath)) {
        const parent = dirMap.get(parentPath)
        if (!parent) break

        const newDir: TreeNode = {
          name: part,
          isDirectory: true,
          children: [],
        }
        parent.children = parent.children ?? []
        parent.children.push(newDir)
        dirMap.set(currentPath, newDir)
      }
    }

    // Add file if within depth limit
    if (parts.length - 1 < maxDepth) {
      const fileName = parts[parts.length - 1]
      const parentPath = parts.slice(0, -1).join('/')

      // Skip if in excluded directory
      let isExcluded = false
      for (const part of parts.slice(0, -1)) {
        if (shouldExclude(part, true)) {
          isExcluded = true
          break
        }
      }

      if (!isExcluded && !shouldExclude(fileName, false)) {
        const parent = dirMap.get(parentPath)
        if (parent) {
          parent.children = parent.children ?? []
          // Avoid duplicates
          if (!parent.children.some((c) => c.name === fileName && !c.isDirectory)) {
            parent.children.push({
              name: fileName,
              isDirectory: false,
            })
          }
        }
      }
    }
  }

  return root
}

/**
 * Mark paths that lead to modified files
 */
function highlightModifiedPaths(tree: TreeNode, modifiedFiles: string[]): void {
  // Build set of all path segments that should be highlighted
  const highlightPaths = new Set<string>()

  for (const file of modifiedFiles) {
    const parts = file.split('/')
    let currentPath = ''
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      highlightPaths.add(currentPath)
    }
  }

  function markNode(node: TreeNode, path: string): void {
    const nodePath = path ? `${path}/${node.name}` : node.name

    if (highlightPaths.has(nodePath) || highlightPaths.has(node.name)) {
      node.isHighlighted = true
    }

    if (node.children) {
      for (const child of node.children) {
        markNode(child, path ? `${path}/${node.name}` : node.name)
      }
    }
  }

  // Start from root's children (root name is the repo name, not part of file paths)
  if (tree.children) {
    for (const child of tree.children) {
      markNode(child, '')
    }
  }
}

/**
 * Sort tree nodes: directories first, then alphabetically
 */
function sortTree(node: TreeNode): void {
  if (node.children) {
    node.children.sort((a, b) => {
      // Highlighted items first
      if (a.isHighlighted && !b.isHighlighted) return -1
      if (!a.isHighlighted && b.isHighlighted) return 1

      // Directories before files
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1

      // Alphabetical
      return a.name.localeCompare(b.name)
    })

    for (const child of node.children) {
      sortTree(child)
    }
  }
}

/**
 * Render tree to string with ASCII art
 */
function renderTree(
  node: TreeNode,
  prefix: string = '',
  isLast: boolean = true,
  isRoot: boolean = true,
  lines: string[] = [],
  maxLines: number = MAX_TREE_LINES
): string[] {
  if (lines.length >= maxLines) {
    if (lines[lines.length - 1] !== '... (truncated)') {
      lines.push('... (truncated)')
    }
    return lines
  }

  const connector = isRoot ? '' : isLast ? '└── ' : '├── '
  const highlight = node.isHighlighted ? ' *' : ''
  const dirMarker = node.isDirectory ? '/' : ''

  lines.push(`${prefix}${connector}${node.name}${dirMarker}${highlight}`)

  if (node.children && node.children.length > 0) {
    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ')

    for (let i = 0; i < node.children.length; i++) {
      if (lines.length >= maxLines) {
        if (lines[lines.length - 1] !== '... (truncated)') {
          lines.push('... (truncated)')
        }
        break
      }

      const child = node.children[i]
      const childIsLast = i === node.children.length - 1
      renderTree(child, childPrefix, childIsLast, false, lines, maxLines)
    }
  }

  return lines
}

/**
 * Extract modified file paths from a diff
 */
export function extractModifiedFilesFromDiff(diffContent: string): string[] {
  const files: string[] = []
  const diffHeaderPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm
  const fileHeaderPattern = /^\+\+\+ b\/(.+?)$/gm

  // Try diff --git format first
  let match
  while ((match = diffHeaderPattern.exec(diffContent)) !== null) {
    const file = match[2]
    if (file && !files.includes(file)) {
      files.push(file)
    }
  }

  // Also try +++ format
  while ((match = fileHeaderPattern.exec(diffContent)) !== null) {
    const file = match[1]
    if (file && file !== '/dev/null' && !files.includes(file)) {
      files.push(file)
    }
  }

  return files
}

/**
 * Read README file and extract first N characters
 */
async function getReadmeSummary(repoRoot: string): Promise<string | undefined> {
  for (const readmeFile of README_FILES) {
    const readmePath = join(repoRoot, readmeFile)
    try {
      const content = await fs.readFile(readmePath, 'utf-8')
      if (content.trim()) {
        // Extract first README_MAX_CHARS characters, but try to end at a sentence or paragraph
        let summary = content.slice(0, README_MAX_CHARS)

        // Try to end at a good breaking point
        if (content.length > README_MAX_CHARS) {
          // Look for paragraph break
          const paragraphEnd = summary.lastIndexOf('\n\n')
          if (paragraphEnd > README_MAX_CHARS * 0.5) {
            summary = summary.slice(0, paragraphEnd)
          } else {
            // Look for sentence end
            const sentenceEnd = Math.max(
              summary.lastIndexOf('. '),
              summary.lastIndexOf('.\n'),
              summary.lastIndexOf('.')
            )
            if (sentenceEnd > README_MAX_CHARS * 0.5) {
              summary = summary.slice(0, sentenceEnd + 1)
            } else {
              summary = summary + '...'
            }
          }
        }

        return summary.trim()
      }
    } catch {
      // File doesn't exist or can't be read, try next
    }
  }

  return undefined
}

/**
 * Read architecture documentation file if present
 */
async function getArchitectureDoc(repoRoot: string): Promise<string | undefined> {
  for (const archFile of ARCHITECTURE_FILES) {
    const archPath = join(repoRoot, archFile)
    try {
      const content = await fs.readFile(archPath, 'utf-8')
      if (content.trim()) {
        // Return full content (typically architecture docs are meant to be read fully)
        // But cap at a reasonable size to avoid overwhelming the context
        const maxArchChars = 2000
        if (content.length > maxArchChars) {
          return content.slice(0, maxArchChars) + '\n\n... (truncated)'
        }
        return content.trim()
      }
    } catch {
      // File doesn't exist or can't be read, try next
    }
  }

  return undefined
}

/**
 * Generate project structure context for code review
 *
 * @param repoRoot - Root directory of the git repository
 * @param diffContent - The diff content to extract modified files from
 * @returns Project structure context with tree, README summary, and architecture doc
 */
export async function getProjectStructureContext(
  repoRoot: string,
  diffContent: string
): Promise<ProjectStructureContext> {
  logger.debug('Generating project structure context...')

  // Extract modified files from diff
  const modifiedFiles = extractModifiedFilesFromDiff(diffContent)
  logger.debug(`Found ${modifiedFiles.length} modified files in diff`)

  // Build directory tree
  const tree = await buildTree(repoRoot)

  // Highlight paths to modified files
  if (modifiedFiles.length > 0) {
    highlightModifiedPaths(tree, modifiedFiles)
  }

  // Sort tree
  sortTree(tree)

  // Render tree to string
  const treeLines = renderTree(tree)
  const directoryTree = treeLines.join('\n')

  // Get README summary
  const readmeSummary = await getReadmeSummary(repoRoot)

  // Get architecture documentation
  const architectureDoc = await getArchitectureDoc(repoRoot)

  logger.debug(
    `Project structure: ${treeLines.length} tree lines, ` +
      `README: ${readmeSummary ? 'yes' : 'no'}, ` +
      `Architecture: ${architectureDoc ? 'yes' : 'no'}`
  )

  return {
    directoryTree,
    readmeSummary,
    architectureDoc,
  }
}

/**
 * Format project structure context for inclusion in review prompt
 */
export function formatProjectStructureContext(context: ProjectStructureContext): string {
  const parts: string[] = []

  parts.push('### Directory Structure')
  parts.push('```')
  parts.push(context.directoryTree)
  parts.push('```')
  parts.push('')
  parts.push('*Files marked with `*` are modified in this change.*')

  if (context.readmeSummary) {
    parts.push('')
    parts.push('### Project README Summary')
    parts.push(context.readmeSummary)
  }

  if (context.architectureDoc) {
    parts.push('')
    parts.push('### Architecture Documentation')
    parts.push(context.architectureDoc)
  }

  return parts.join('\n')
}
