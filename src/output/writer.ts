/**
 * Output writer for writing review results to stdout or file
 */
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ReviewOutput, WriteOptions } from './types.js'
import { formatAsText, formatAsJson, formatAsMarkdown } from './formatters.js'

/**
 * Remove ANSI escape sequences and non-whitespace C0 control characters
 * that an LLM may have echoed from a malicious diff (terminal-title injection,
 * screen-clear, bell, etc.). Applied only on the stdout path — file output
 * preserves raw bytes so archived reviews are byte-identical to the model
 * response.
 *
 * Strips:
 *   - CSI sequences: ESC [ ... <final byte 0x40-0x7E>
 *   - OSC sequences: ESC ] ... <BEL or ST>
 *   - Other ESC <Fp>… intermediate / final byte two-character sequences
 *   - C0 controls except \t (0x09), \n (0x0A), \r (0x0D)
 *   - DEL (0x7F)
 */
function stripTerminalControls(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')   // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')               // OSC
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, '')                               // Single-shift / two-byte ESC
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')            // C0 (except \t \n \r) + DEL
}

/**
 * Write review output to stdout or file based on options
 */
export async function writeReviewOutput(
  review: ReviewOutput,
  options: WriteOptions
): Promise<void> {
  const formattedContent = getFormattedContent(review, options.format)

  // Write to file if specified — preserves raw bytes for archival fidelity.
  if (options.outputFile) {
    await writeToFile(options.outputFile, formattedContent)
  }

  // Output to stdout if not quiet mode — strip control sequences so a
  // malicious diff cannot drive the operator's terminal.
  if (!options.quiet) {
    console.log(stripTerminalControls(formattedContent))
  }
}

/**
 * Write content to a file, creating directories if needed
 */
async function writeToFile(filePath: string, content: string): Promise<void> {
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
