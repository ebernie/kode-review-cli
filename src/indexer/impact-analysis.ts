/**
 * Impact Analysis Module
 *
 * Provides impact analysis for modified files during code review,
 * including import tree analysis, hub file detection, and circular dependency warnings.
 */

import type { IndexerClient } from './client.js'
import type {
  ImportTree,
  CircularDependency,
  HubFile,
  ImpactWarning,
  ImpactAnalysisResult,
  ImpactSeverity,
} from './types.js'
import { logger } from '../utils/logger.js'

/**
 * Timeout for individual API calls to prevent blocking the review
 */
const API_TIMEOUT_MS = 5000

/**
 * Maximum number of modified files to analyze for import trees
 * (to prevent slowdown on large PRs)
 */
const MAX_FILES_FOR_IMPORT_TREE = 10

/**
 * Threshold for hub file detection (files imported by at least this many others)
 */
const HUB_FILE_THRESHOLD = 10

/**
 * Threshold for very high impact hub files (critical severity)
 */
const CRITICAL_HUB_THRESHOLD = 20

/**
 * Run a promise with a timeout
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  const timeoutPromise = new Promise<T>((resolve) =>
    setTimeout(() => resolve(fallback), timeoutMs)
  )
  return Promise.race([promise, timeoutPromise])
}

/**
 * Determine severity for a hub file warning based on import count
 */
function getHubFileSeverity(importCount: number): ImpactSeverity {
  if (importCount >= CRITICAL_HUB_THRESHOLD) {
    return 'critical'
  }
  if (importCount >= HUB_FILE_THRESHOLD) {
    return 'high'
  }
  return 'medium'
}

/**
 * Determine severity for a circular dependency warning
 */
function getCircularDepSeverity(cycleType: 'direct' | 'indirect'): ImpactSeverity {
  return cycleType === 'direct' ? 'high' : 'medium'
}

/**
 * Generate a warning message for a hub file
 */
function getHubFileMessage(_filePath: string, importCount: number): string {
  if (importCount >= CRITICAL_HUB_THRESHOLD) {
    return `This file is a critical hub imported by ${importCount} other files. Changes here have very high blast radius and may affect many parts of the codebase.`
  }
  return `This file is imported by ${importCount} other files. Changes here have significant impact across the codebase.`
}

/**
 * Generate a warning message for a circular dependency
 */
function getCircularDepMessage(_cycle: string[], cycleType: 'direct' | 'indirect'): string {
  if (cycleType === 'direct') {
    return `This file is part of a direct circular dependency (A→B→A). This may cause initialization issues or tight coupling.`
  }
  return `This file is part of an indirect circular dependency cycle. Consider refactoring to break the cycle.`
}

/**
 * Generate a warning message for high-impact changes
 */
function getHighImpactMessage(_filePath: string, affectedCount: number): string {
  return `Changes to this file directly affect ${affectedCount} other files. Ensure changes are backward compatible or update all affected files.`
}

/**
 * Perform impact analysis on a set of modified files.
 *
 * This function:
 * 1. Gets import trees for each modified file (limited to first 10)
 * 2. Queries hub files for the repository once
 * 3. Queries circular dependencies for the repository once
 * 4. Cross-references modified files with hub files and circular deps
 * 5. Generates warnings with appropriate severity levels
 *
 * All API calls have a 5s timeout to prevent blocking the review.
 *
 * @param modifiedFiles - List of file paths that were modified
 * @param client - IndexerClient instance
 * @param repoUrl - Repository URL for scoping queries
 * @param branch - Optional branch to scope queries
 * @returns Impact analysis result with warnings, import trees, and metadata
 */
export async function getImpactAnalysis(
  modifiedFiles: string[],
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<ImpactAnalysisResult> {
  const warnings: ImpactWarning[] = []
  const importTrees = new Map<string, ImportTree>()
  let hubFiles: HubFile[] = []
  let circularDependencies: CircularDependency[] = []

  // Create a set for quick lookup of modified files (normalized paths)
  const modifiedSet = new Set(modifiedFiles.map(f => f.replace(/\\/g, '/')))

  // 1. Get import trees for each modified file (limited)
  const filesToAnalyze = modifiedFiles.slice(0, MAX_FILES_FOR_IMPORT_TREE)
  const importTreePromises = filesToAnalyze.map(async (filePath) => {
    try {
      const tree = await withTimeout(
        client.getImportTree(filePath, repoUrl, branch),
        API_TIMEOUT_MS,
        null as unknown as ImportTree
      )
      if (tree && tree.targetFile) {
        return { filePath, tree }
      }
    } catch (error) {
      logger.debug(`Import tree lookup failed for "${filePath}": ${error}`)
    }
    return null
  })

  // 2. Get hub files for the repository
  const hubFilesPromise = withTimeout(
    client.getHubFiles(repoUrl, branch, HUB_FILE_THRESHOLD, 50),
    API_TIMEOUT_MS,
    { hubFiles: [], totalCount: 0, threshold: HUB_FILE_THRESHOLD, repoUrl, branch: branch || 'main' }
  ).catch((error) => {
    logger.debug(`Hub files lookup failed: ${error}`)
    return { hubFiles: [], totalCount: 0, threshold: HUB_FILE_THRESHOLD, repoUrl, branch: branch || 'main' }
  })

  // 3. Get circular dependencies for the repository
  const circularDepsPromise = withTimeout(
    client.getCircularDependencies(repoUrl, branch),
    API_TIMEOUT_MS,
    { circularDependencies: [], totalCount: 0, repoUrl, branch: branch || 'main' }
  ).catch((error) => {
    logger.debug(`Circular dependencies lookup failed: ${error}`)
    return { circularDependencies: [], totalCount: 0, repoUrl, branch: branch || 'main' }
  })

  // Wait for all results in parallel
  const [importTreeResults, hubFilesResult, circularDepsResult] = await Promise.all([
    Promise.all(importTreePromises),
    hubFilesPromise,
    circularDepsPromise,
  ])

  // Process import tree results
  for (const result of importTreeResults) {
    if (result) {
      importTrees.set(result.filePath, result.tree)

      // Generate high-impact warning for files with many direct importers
      const directImporterCount = result.tree.directImporters.length
      if (directImporterCount >= 5) {
        warnings.push({
          type: 'high_impact_change',
          severity: directImporterCount >= 10 ? 'high' : 'medium',
          filePath: result.filePath,
          message: getHighImpactMessage(result.filePath, directImporterCount),
          details: {
            affectedFiles: result.tree.directImporters.slice(0, 10), // Limit to first 10
          },
        })
      }
    }
  }

  // Process hub files result
  hubFiles = hubFilesResult.hubFiles

  // Check which modified files are hub files
  for (const hub of hubFiles) {
    const normalizedHubPath = hub.filePath.replace(/\\/g, '/')

    // Check if this hub file is modified
    if (modifiedSet.has(normalizedHubPath)) {
      warnings.push({
        type: 'hub_file',
        severity: getHubFileSeverity(hub.importCount),
        filePath: hub.filePath,
        message: getHubFileMessage(hub.filePath, hub.importCount),
        details: {
          importCount: hub.importCount,
          affectedFiles: hub.importers.slice(0, 10), // Limit to first 10
        },
      })
    }
  }

  // Process circular dependencies result
  circularDependencies = circularDepsResult.circularDependencies

  // Check which modified files are part of circular dependencies
  for (const circDep of circularDependencies) {
    // Normalize cycle paths for comparison
    const normalizedCycle = circDep.cycle.map(f => f.replace(/\\/g, '/'))

    // Check if any modified file is in this cycle
    for (const filePath of modifiedFiles) {
      const normalizedPath = filePath.replace(/\\/g, '/')

      if (normalizedCycle.includes(normalizedPath)) {
        // Avoid duplicate warnings for the same file
        const existingWarning = warnings.find(
          w => w.type === 'circular_dependency' && w.filePath === filePath
        )

        if (!existingWarning) {
          warnings.push({
            type: 'circular_dependency',
            severity: getCircularDepSeverity(circDep.cycleType),
            filePath,
            message: getCircularDepMessage(circDep.cycle, circDep.cycleType),
            details: {
              cycle: circDep.cycle,
            },
          })
        }
      }
    }
  }

  // Sort warnings by severity (critical first, then high, then medium)
  const severityOrder: Record<ImpactSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
  }
  warnings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  logger.debug(`Impact analysis complete: ${warnings.length} warnings, ${importTrees.size} import trees`)

  return {
    warnings,
    importTrees,
    hubFiles,
    circularDependencies,
  }
}
