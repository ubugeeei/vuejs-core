import type { RootIRNode } from './ir'
import { compileTimeComputation } from './optimizations/compileTimeComputation'

export function optimize(ir: RootIRNode): void {
  compileTimeComputation(ir)
}
