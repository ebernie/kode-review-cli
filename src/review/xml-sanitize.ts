/**
 * Defensive XML escaping for prompt sections that wrap untrusted content
 * (PR/MR descriptions, diff bodies, etc.) inside structural tags.
 *
 * Escapes any structural tag occurrence in the content to prevent the
 * embedded text from breaking out of its section. The list of structural
 * tags is intentionally a closed set — callers should add new tags here
 * when they introduce new prompt sections.
 */

export const STRUCTURAL_TAGS = [
  'pr_mr_info',
  'related_code',
  'diff_content',
  'author_intent',
  'project_structure',
  'trust_boundaries',
  // XML context section tags
  'modified',
  'similar',
  'test',
  'definition',
  'config',
  'import',
  'context',
  // Impact analysis tags
  'impact',
  'warning',
  'affected_files',
  'cycle',
  'import_tree',
  'imports',
  'imported_by',
]

/**
 * Escape any structural tag occurrence in `content` so it cannot break out
 * of its enclosing prompt section. Both opening and closing tag forms are
 * escaped, case-insensitively.
 */
export function sanitizeXmlContent(content: string, _tagName: string): string {
  let sanitized = content

  for (const tag of STRUCTURAL_TAGS) {
    sanitized = sanitized.replace(
      new RegExp(`</${tag}>`, 'gi'),
      `<\\/${tag}>`,
    )
    sanitized = sanitized.replace(
      new RegExp(`<${tag}>`, 'gi'),
      `<\\${tag}>`,
    )
  }

  return sanitized
}
