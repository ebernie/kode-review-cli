/**
 * Schema for structured findings emitted alongside the human-readable review.
 *
 * Inspired by clawpatch's review output discipline: required evidence,
 * fixed category enum, and a confidence axis distinct from severity so
 * downstream consumers can triage on (severity × confidence) instead of
 * a single noisy axis.
 */
import { z } from 'zod'

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
export const CATEGORIES = [
  'security',
  'correctness',
  'performance',
  'maintainability',
  'concurrency',
  'api-contract',
  'error-handling',
  'testing',
  'documentation',
  'other',
] as const
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const

export const FindingSchema = z
  .object({
    severity: z.enum(SEVERITIES),
    category: z.enum(CATEGORIES),
    confidence: z.enum(CONFIDENCES),
    title: z.string().trim().min(1).max(200),
    file: z.string().trim().min(1),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    evidence: z.string().trim().min(1),
    problem: z.string().trim().min(1),
    recommendation: z.string().trim().min(1),
  })
  .refine((f) => f.lineEnd >= f.lineStart, {
    message: 'lineEnd must be >= lineStart',
    path: ['lineEnd'],
  })

export type Finding = z.infer<typeof FindingSchema>

export const FindingsBlockSchema = z.object({
  findings: z.array(FindingSchema),
})

export type FindingsBlock = z.infer<typeof FindingsBlockSchema>
