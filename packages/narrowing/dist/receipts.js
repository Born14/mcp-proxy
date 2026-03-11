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
import { createHash } from 'crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { dirname } from 'path';
// =============================================================================
// DETERMINISTIC SERIALIZATION
// =============================================================================
/**
 * Stable JSON stringification with sorted keys.
 * Deterministic — same input always produces same output.
 */
export function stableStringify(obj) {
    if (obj === null || obj === undefined)
        return 'null';
    if (typeof obj !== 'object')
        return JSON.stringify(obj);
    if (Array.isArray(obj)) {
        return '[' + obj.map(stableStringify).join(',') + ']';
    }
    const sorted = Object.keys(obj).sort();
    const pairs = sorted.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return '{' + pairs.join(',') + '}';
}
/**
 * SHA-256 hash of a string.
 */
export function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
// =============================================================================
// RECEIPT CHAIN
// =============================================================================
export class ReceiptChain {
    path;
    lastHash = 'genesis';
    count = 0;
    constructor(path) {
        this.path = path;
        this.ensureDir();
        this.loadLastHash();
    }
    /**
     * Append a receipt to the chain.
     * Returns the receipt with its computed hash.
     */
    append(type, payload, attempt) {
        const canonical = stableStringify(payload);
        const hash = sha256(this.lastHash + canonical);
        const receipt = {
            hash,
            previousHash: this.lastHash,
            timestamp: Date.now(),
            type,
            payload,
            attempt,
        };
        appendFileSync(this.path, JSON.stringify(receipt) + '\n');
        this.lastHash = hash;
        this.count++;
        return receipt;
    }
    /**
     * Verify the entire chain for tampering.
     * Returns { valid: true } or { valid: false, brokenAt: index }.
     */
    verify() {
        const receipts = this.readAll();
        let expectedPrev = 'genesis';
        for (let i = 0; i < receipts.length; i++) {
            const r = receipts[i];
            // Check previous hash linkage
            if (r.previousHash !== expectedPrev) {
                return { valid: false, brokenAt: i, receiptCount: receipts.length };
            }
            // Recompute hash
            const canonical = stableStringify(r.payload);
            const expectedHash = sha256(expectedPrev + canonical);
            if (r.hash !== expectedHash) {
                return { valid: false, brokenAt: i, receiptCount: receipts.length };
            }
            expectedPrev = r.hash;
        }
        return { valid: true, receiptCount: receipts.length };
    }
    /** Read all receipts */
    readAll() {
        if (!existsSync(this.path))
            return [];
        const content = readFileSync(this.path, 'utf-8').trim();
        if (!content)
            return [];
        return content.split('\n')
            .filter(line => line.trim())
            .map(line => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((r) => r !== null);
    }
    /** Get the last hash (for external chaining) */
    getLastHash() {
        return this.lastHash;
    }
    /** Get the receipt count */
    getCount() {
        return this.count;
    }
    // =========================================================================
    // INTERNAL
    // =========================================================================
    loadLastHash() {
        const receipts = this.readAll();
        if (receipts.length > 0) {
            this.lastHash = receipts[receipts.length - 1].hash;
            this.count = receipts.length;
        }
    }
    ensureDir() {
        const dir = dirname(this.path);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }
}
//# sourceMappingURL=receipts.js.map