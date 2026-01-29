/**
 * Output writer for writing review results to stdout or file
 */
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ReviewOutput, WriteOptions } from './types.js'
import { formatAsText, formatAsJson, formatAsMarkdown } from './formatters.js'

/**
 * Write review output to stdout or file based on options
 */
export async function writeReviewOutput(
  review: ReviewOutput,
  options: WriteOptions
): Promise<void> {
  // Format the output based on format option
  let formattedContent: string

  switch (options.format) {
    case 'json':
      formattedContent = formatAsJson(review, { includeMetadata: true })
      break
    case 'markdown':
      formattedContent = formatAsMarkdown(review, { includeMetadata: true })
      break
    case 'text':
    default:
      formattedContent = formatAsText(review)
      break
  }

  // Write to file if specified
  if (options.outputFile) {
    await writeToFile(options.outputFile, formattedContent)
  }

  // Output to stdout if not quiet mode
  if (!options.quiet) {
    console.log(formattedContent)
  }
}

/**
 * Write content to a file, creating directories if needed
 */
async function writeToFile(filePath: string, content: string): Promise<void> {
  // Ensure directory exists
  const dir = dirname(filePath)
  if (dir && dir !== '.') {
    await mkdir(dir, { recursive: true })
  }

  await writeFile(filePath, content, 'utf-8')
}

/**
 * Get formatted content without writing (useful for display or posting)
 */
export function getFormattedContent(
  review: ReviewOutput,
  format: WriteOptions['format']
): string {
  switch (format) {
    case 'json':
      return formatAsJson(review, { includeMetadata: true })
    case 'markdown':
      return formatAsMarkdown(review, { includeMetadata: true })
    case 'text':
    default:
      return formatAsText(review)
  }
}
