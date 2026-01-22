/**
 * XML Context Formatting Module
 *
 * Provides structured XML formatting for code context delivered to the LLM.
 * This enables better parsing and referencing of code sections with rich metadata.
 */

import type { WeightedCodeChunk, ChunkType } from './types.js'

/**
 * Context types for categorizing code sections
 */
export type ContextType =
  | 'modified'     // Code that overlaps with modified lines in the diff
  | 'similar'      // Semantically similar code found via vector search
  | 'definition'   // Type/function/class definitions
  | 'test'         // Test file related to modified source
  | 'config'       // Configuration files
  | 'import'       // Imported/dependency code

/**
 * Relevance level for context sections
 */
export type RelevanceLevel = 'high' | 'medium' | 'low'

/**
 * XML context section metadata
 */
export interface XmlContextMetadata {
  /** Type of context (modified, similar, definition, test, config) */
  type: ContextType

  /** File path relative to repo root */
  path: string

  /** Relevance level based on weighting */
  relevance: RelevanceLevel

  /** Starting line number (1-indexed) */
  lineStart: number

  /** Ending line number (1-indexed) */
  lineEnd: number

  /** Reason this context was retrieved */
  reason: string

  /** Type of code construct (function, class, etc.) - optional */
  chunkType?: ChunkType

  /** Related source file (for test files) - optional */
  relatedSource?: string

  /** Original similarity score - optional */
  score?: number
}

/**
 * Escape XML special characters in content
 */
function escapeXmlContent(content: string): string {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Escape XML attribute values (double quotes)
 */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Determine the context type for a weighted code chunk
 */
export function getContextType(chunk: WeightedCodeChunk): ContextType {
  if (chunk.isTestFile) {
    return 'test'
  }
  if (chunk.isModifiedContext) {
    return 'modified'
  }
  // TODO: In the future, we could detect config files and definitions
  // For now, default to 'similar' for semantically retrieved code
  return 'similar'
}

/**
 * Determine the relevance level based on the weighted score
 */
export function getRelevanceLevel(chunk: WeightedCodeChunk): RelevanceLevel {
  // High relevance: modified context, test files, or high score with boosts
  if (chunk.isModifiedContext || chunk.isTestFile) {
    return 'high'
  }
  if (chunk.matchesDescriptionIntent && chunk.score > 0.7) {
    return 'high'
  }

  // Medium relevance: decent score or matches description intent
  if (chunk.score > 0.5 || chunk.matchesDescriptionIntent) {
    return 'medium'
  }

  // Low relevance: everything else
  return 'low'
}

/**
 * Generate a human-readable retrieval reason for the chunk
 */
export function getRetrievalReason(chunk: WeightedCodeChunk): string {
  const reasons: string[] = []

  if (chunk.isModifiedContext) {
    reasons.push('overlaps with modified lines')
  }

  if (chunk.isTestFile) {
    if (chunk.relatedSourceFile) {
      reasons.push(`test file for ${chunk.relatedSourceFile}`)
    } else {
      reasons.push('related test file')
    }
  }

  if (chunk.matchesDescriptionIntent) {
    reasons.push('matches PR/MR description intent')
  }

  if (reasons.length === 0) {
    reasons.push('semantically similar to changes')
  }

  return reasons.join('; ')
}

/**
 * Format a single code chunk as an XML context element
 */
export function formatChunkAsXml(chunk: WeightedCodeChunk): string {
  const contextType = getContextType(chunk)
  const relevance = getRelevanceLevel(chunk)
  const reason = getRetrievalReason(chunk)

  // Build attributes
  const attributes: string[] = [
    `type="${escapeXmlAttribute(contextType)}"`,
    `path="${escapeXmlAttribute(chunk.filename)}"`,
    `relevance="${escapeXmlAttribute(relevance)}"`,
    `lines="${chunk.startLine}-${chunk.endLine}"`,
    `reason="${escapeXmlAttribute(reason)}"`,
  ]

  // Add optional score attribute for transparency
  if (chunk.originalScore !== undefined) {
    attributes.push(`score="${chunk.originalScore.toFixed(3)}"`)
  }

  // Build the XML element
  const openTag = `<context ${attributes.join(' ')}>`
  const closeTag = '</context>'

  // Escape the code content
  const escapedCode = escapeXmlContent(chunk.code)

  return `${openTag}\n${escapedCode}\n${closeTag}`
}

/**
 * Group chunks by context type for organized output
 */
export function groupChunksByType(chunks: WeightedCodeChunk[]): Map<ContextType, WeightedCodeChunk[]> {
  const groups = new Map<ContextType, WeightedCodeChunk[]>()

  for (const chunk of chunks) {
    const type = getContextType(chunk)
    const existing = groups.get(type) || []
    existing.push(chunk)
    groups.set(type, existing)
  }

  return groups
}

/**
 * Section order for output (most relevant first)
 */
const SECTION_ORDER: ContextType[] = ['modified', 'test', 'definition', 'similar', 'config', 'import']

/**
 * Format all chunks as structured XML with sections
 *
 * Output structure:
 * <modified>
 *   <context type="modified" path="..." lines="..." relevance="..." reason="...">
 *     code content
 *   </context>
 * </modified>
 * <similar>
 *   <context type="similar" ...>
 *     code content
 *   </context>
 * </similar>
 * etc.
 */
export function formatContextAsXml(chunks: WeightedCodeChunk[]): string {
  if (chunks.length === 0) {
    return ''
  }

  const groupedChunks = groupChunksByType(chunks)
  const parts: string[] = []

  // Output sections in priority order
  for (const sectionType of SECTION_ORDER) {
    const sectionChunks = groupedChunks.get(sectionType)
    if (!sectionChunks || sectionChunks.length === 0) {
      continue
    }

    // Sort chunks within section by score (descending)
    sectionChunks.sort((a, b) => b.score - a.score)

    // Build section
    parts.push(`<${sectionType}>`)

    for (const chunk of sectionChunks) {
      parts.push(formatChunkAsXml(chunk))
    }

    parts.push(`</${sectionType}>`)
    parts.push('')
  }

  return parts.join('\n').trim()
}

/**
 * Generate XML schema documentation for the LLM prompt
 */
export function getXmlSchemaDocumentation(): string {
  return `The related code context uses structured XML format with the following schema:

**Section Tags** (contain multiple context elements):
- \`<modified>\`: Code chunks that overlap with lines being modified in this change
- \`<similar>\`: Semantically similar code found via vector search
- \`<test>\`: Related test files for the modified source files
- \`<definition>\`: Type, interface, or function definitions
- \`<config>\`: Configuration files

**Context Element Attributes**:
- \`type\`: The context category (modified, similar, test, definition, config)
- \`path\`: File path relative to repository root
- \`relevance\`: Importance level (high, medium, low)
- \`lines\`: Line range in format "start-end"
- \`reason\`: Why this context was retrieved
- \`score\`: Similarity score (0-1, higher = more similar)

**Example**:
\`\`\`xml
<modified>
<context type="modified" path="src/utils/parser.ts" relevance="high" lines="45-67" reason="overlaps with modified lines" score="0.892">
export function parseConfig(input: string): Config {
  // ... code content ...
}
</context>
</modified>
\`\`\`

When citing related code in your review, reference it by path and line numbers (e.g., "The related code in \`src/utils/parser.ts:45-67\` shows...").`
}
