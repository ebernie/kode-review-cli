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
  'prior_findings',
  'finding',
  'feature_metadata',
  'file',
  'tests',
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
 * of its enclosing prompt section. Matches:
 *   - Plain forms:              `<tag>`, `</tag>`
 *   - Whitespace variants:      `</tag >`, `<tag  >`
 *   - Attribute variants:       `<tag attr="x">`, `<tag a="x" b='y'>`, `<tag />`
 *   - Closing-tag attr variants:`</tag foo="bar">` (malformed but injection-relevant)
 * Case-insensitive. Idempotent (already-escaped `<\tag>` forms are left
 * unchanged because the inserted backslash prevents a re-match).
 *
 * The `_tagName` parameter is unused but retained for callers that pass it
 * for documentation / locality of reasoning.
 */
export function sanitizeXmlContent(content: string, _tagName?: string): string {
  let sanitized = content

  for (const tag of STRUCTURAL_TAGS) {
    // Closing tag: </tag>, </tag >, or </tag attr="x"> (malformed but injection-relevant).
    // `([^>]*)` captures everything up to the first `>`, preserving the suffix literally.
    sanitized = sanitized.replace(
      new RegExp(`</(${tag})([^>]*)>`, 'gi'),
      '<\\/$1$2>',
    )
    // Opening tag: <tag>, <tag\s+attrs>, <tag />, <tag attr/>
    // The capture covers everything between `<tag` and the closing `>`, so
    // attribute syntax inside the match is preserved literally.
    sanitized = sanitized.replace(
      new RegExp(`<(${tag})((?:\\s[^>]*)?\\s*/?)>`, 'gi'),
      '<\\$1$2>',
    )
  }

  return sanitized
}
