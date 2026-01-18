import chalk, { Chalk, type ChalkInstance } from 'chalk'

/**
 * Check if we're running in a TTY (interactive terminal)
 */
export function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

/**
 * Get chalk with appropriate color level
 */
function getChalk(): ChalkInstance {
  if (!isTTY()) {
    // Disable colors when not in TTY
    return new Chalk({ level: 0 })
  }
  return chalk
}

const colors = getChalk()

export const red = colors.red
export const green = colors.green
export const yellow = colors.yellow
export const blue = colors.blue
export const cyan = colors.cyan
export const gray = colors.gray
export const bold = colors.bold
export const dim = colors.dim

export { colors }
