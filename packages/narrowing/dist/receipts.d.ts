/**
 * Tamper-Evident Receipt Chain
 *
 * Every narrowing decision produces a receipt — an immutable record
 * with a cryptographic hash chain. Any modification breaks the chain
 * downstream.
 *
 * Format: JSONL. Each receipt: hash = sha256(previousHash + payload).
 * First receipt uses previousHash = 'genesis'.
 *
 * Reuses the pattern from @sovereign-labs/mcp-proxy.
 */
export interface Receipt {
    /** SHA-256 hash of this receipt */
    hash: string;
    /** Hash of the previous receipt (or 'genesis') */
    previousHash: string;
    /** When this receipt was created */
    timestamp: number;
    /** What happened */
    type: 'outcome_recorded' | 'constraint_seeded' | 'proposal_blocked' | 'proposal_allowed' | 'convergence_escalation';
    /** The payload — deterministically serialized */
    payload: Record<string, unknown>;
    /** Attempt number */
    attempt: number;
}
/**
 * Stable JSON stringification with sorted keys.
 * Deterministic — same input always produces same output.
 */
export declare function stableStringify(obj: unknown): string;
/**
 * SHA-256 hash of a string.
 */
export declare function sha256(input: string): string;
export declare class ReceiptChain {
    private readonly path;
    private lastHash;
    private count;
    constructor(path: string);
    /**
     * Append a receipt to the chain.
     * Returns the receipt with its computed hash.
     */
    append(type: Receipt['type'], payload: Record<string, unknown>, attempt: number): Receipt;
    /**
     * Verify the entire chain for tampering.
     * Returns { valid: true } or { valid: false, brokenAt: index }.
     */
    verify(): {
        valid: boolean;
        brokenAt?: number;
        receiptCount: number;
    };
    /** Read all receipts */
    readAll(): Receipt[];
    /** Get the last hash (for external chaining) */
    getLastHash(): string;
    /** Get the receipt count */
    getCount(): number;
    private loadLastHash;
    private ensureDir;
}
//# sourceMappingURL=receipts.d.ts.map