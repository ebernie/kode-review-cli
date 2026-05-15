import { square } from './utils.js'

export class Calculator {
  add(a: number, b: number): number {
    return a + b
  }

  squareSum(a: number, b: number): number {
    return square(this.add(a, b))
  }
}
