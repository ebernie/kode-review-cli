import { z } from 'zod'

/**
 * VCS provider configuration
 */
export const VcsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  authenticated: z.boolean().default(false),
})

/**
 * File-type strategy configuration for optimized context retrieval
 */
export const FileTypeStrategyOverridesSchema = z.object({
  /** Override priority weight for specific file types */
  priorityWeights: z.record(z.string(), z.number()).optional(),

  /** Disable specific strategies */
  disabledStrategies: z.array(z.enum([
    'typescript', 'javascript', 'python', 'go', 'css', 'scss', 'rust', 'java', 'generic'
  ])).optional(),

  /** Custom extension mappings (e.g., { '.mts': 'typescript' }) */
  extensionMappings: z.record(z.string(), z.enum([
    'typescript', 'javascript', 'python', 'go', 'css', 'scss', 'rust', 'java', 'generic'
  ])).optional(),
}).default({})

/**
 * Indexer configuration for semantic code search
 */
export const IndexerConfigSchema = z.object({
  /** Whether the indexer feature is enabled */
  enabled: z.boolean().default(false),

  /** Docker Compose project name */
  composeProject: z.string().default('kode-review-indexer'),

  /** Port for the indexer API */
  apiPort: z.number().default(8321),

  /** Port for the PostgreSQL database */
  dbPort: z.number().default(5436),

  /** Embedding model to use */
  embeddingModel: z.string().default('sentence-transformers/all-MiniLM-L6-v2'),

  /** Chunk size for code splitting */
  chunkSize: z.number().default(1000),

  /** Overlap between chunks */
  chunkOverlap: z.number().default(300),

  /** Number of results to return from search */
  topK: z.number().default(5),

  /** Maximum tokens for context */
  maxContextTokens: z.number().default(4000),

  /** File patterns to include */
  includedPatterns: z.array(z.string()).default([
    '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
    '**/*.py', '**/*.rs', '**/*.go', '**/*.java',
    '**/*.c', '**/*.cpp', '**/*.h', '**/*.cs',
  ]),

  /** File patterns to exclude */
  excludedPatterns: z.array(z.string()).default([
    '**/node_modules/**', '**/dist/**', '**/build/**',
    '**/.git/**', '**/vendor/**', '**/target/**',
  ]),

  /** File-type specific retrieval strategy overrides */
  fileTypeStrategies: FileTypeStrategyOverridesSchema,
})

/**
 * Main configuration schema
 */
export const ConfigSchema = z.object({
  // Provider/model settings
  provider: z.string().default('anthropic'),
  model: z.string().default('claude-sonnet-4-20250514'),
  variant: z.string().optional(),

  // Antigravity integration
  antigravity: z.object({
    enabled: z.boolean().default(false),
    pluginInstalled: z.boolean().default(false),
    authenticated: z.boolean().default(false),
  }).default({}),

  // VCS integration
  github: VcsConfigSchema.default({}),
  gitlab: VcsConfigSchema.default({}),

  // Indexer integration
  indexer: IndexerConfigSchema.default({}),

  // State
  onboardingComplete: z.boolean().default(false),
})

export type Config = z.infer<typeof ConfigSchema>
export type VcsConfig = z.infer<typeof VcsConfigSchema>
export type IndexerConfigType = z.infer<typeof IndexerConfigSchema>
export type FileTypeStrategyOverridesType = z.infer<typeof FileTypeStrategyOverridesSchema>

/**
 * Default configuration
 */
export const defaultConfig: Config = ConfigSchema.parse({})

/**
 * Provider display names
 */
export const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  google: 'Google (Gemini)',
  openai: 'OpenAI (GPT)',
  opencode: 'OpenCode Zen',
  antigravity: 'Antigravity (Free via Google OAuth)',
}
