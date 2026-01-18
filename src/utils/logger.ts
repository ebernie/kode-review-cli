import { red, green, yellow, blue, dim } from '../cli/colors.js'

export type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error'

let quietMode = false

export function setQuietMode(quiet: boolean): void {
  quietMode = quiet
}

export function log(level: LogLevel, message: string): void {
  if (quietMode && level !== 'error') return

  const prefix = {
    debug: dim('[DEBUG]'),
    info: blue('[INFO]'),
    success: green('[OK]'),
    warn: yellow('[WARN]'),
    error: red('[ERROR]'),
  }[level]

  const output = `${prefix} ${message}`

  if (level === 'error') {
    console.error(output)
  } else {
    console.log(output)
  }
}

export const logger = {
  debug: (msg: string) => log('debug', msg),
  info: (msg: string) => log('info', msg),
  success: (msg: string) => log('success', msg),
  warn: (msg: string) => log('warn', msg),
  error: (msg: string) => log('error', msg),
}

/**
 * Output JSON (always outputs, even in quiet mode)
 */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

/**
 * Output error as JSON
 */
export function errorJson(error: string): void {
  console.log(JSON.stringify({ error }))
}
