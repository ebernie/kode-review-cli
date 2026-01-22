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
 * Antigravity model definition for OpenCode config
 */
export const AntigravityModelSchema = z.object({
  name: z.string(),
  limit: z.object({
    context: z.number(),
    output: z.number(),
  }),
  modalities: z.object({
    input: z.array(z.string()),
    output: z.array(z.string()),
  }),
  variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
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
export type AntigravityModel = z.infer<typeof AntigravityModelSchema>
export type IndexerConfigType = z.infer<typeof IndexerConfigSchema>
export type FileTypeStrategyOverridesType = z.infer<typeof FileTypeStrategyOverridesSchema>

/**
 * Default configuration
 */
export const defaultConfig: Config = ConfigSchema.parse({})

/**
 * Antigravity models to add to OpenCode config
 */
export const ANTIGRAVITY_MODELS: Record<string, AntigravityModel> = {
  'antigravity-claude-sonnet-4-5-thinking': {
    name: 'Claude Sonnet 4.5 Thinking (Antigravity)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  },
  'antigravity-claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5 (Antigravity)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  },
  'antigravity-claude-opus-4-5-thinking': {
    name: 'Claude Opus 4.5 Thinking (Antigravity)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  },
  'antigravity-gemini-3-pro': {
    name: 'Gemini 3 Pro (Antigravity)',
    limit: { context: 1048576, output: 65535 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: {
      low: { thinkingLevel: 'low' },
      high: { thinkingLevel: 'high' },
    },
  },
  'antigravity-gemini-3-flash': {
    name: 'Gemini 3 Flash (Antigravity)',
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: {
      minimal: { thinkingLevel: 'minimal' },
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    },
  },
}

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
