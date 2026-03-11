/**
 * ML Training Adapter — Domain translation for ML training loops.
 *
 * Designed for Karpathy's autoresearch pattern:
 * - Fixed evaluation metric (val_bpb — bits per byte)
 * - Fixed time budget (5 min)
 * - Agent modifies train.py hyperparameters and architecture
 * - Score direction: minimize (lower bpb = better)
 *
 * 13 failure signatures, 8 action classes, source-sensitive blame.
 */
import type { DomainAdapter } from '../types.js';
/**
 * Create an ML Training domain adapter.
 *
 * Usage:
 *   import { createMLTrainingAdapter } from '@sovereign-labs/narrowing/adapters/ml-training';
 *   const adapter = createMLTrainingAdapter();
 *   const loop = new NarrowingLoop({ adapter, direction: 'minimize' });
 */
export declare function createMLTrainingAdapter(): DomainAdapter;
/**
 * Helper: compute parameter deltas between two parameter sets.
 * Returns delta markers that enable action class detection.
 */
export declare function computeParameterDeltas(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=ml-training.d.ts.map