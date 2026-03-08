/**
 * Failure Kind Classification — Unit Tests
 */

import { describe, test, expect } from 'bun:test';
import { classifyFailureKind } from '../src/failure-kind.js';

describe('Failure Kind Classification', () => {

  // --- HARNESS FAULTS ---

  test('DNS resolution failure is harness_fault', () => {
    expect(classifyFailureKind('getaddrinfo EAI_AGAIN db')).toBe('harness_fault');
    expect(classifyFailureKind('getaddrinfo ENOTFOUND redis')).toBe('harness_fault');
    expect(classifyFailureKind('EAI_AGAIN')).toBe('harness_fault');
  });

  test('ECONNREFUSED in staging is harness_fault', () => {
    expect(classifyFailureKind('ECONNREFUSED 127.0.0.1:5432', 'staging')).toBe('harness_fault');
    expect(classifyFailureKind('connection refused', 'staging')).toBe('harness_fault');
  });

  test('ECONNREFUSED outside staging is not harness_fault', () => {
    expect(classifyFailureKind('ECONNREFUSED 127.0.0.1:3000', 'post_deploy_evidence')).not.toBe('harness_fault');
  });

  test('port conflicts are harness_fault', () => {
    expect(classifyFailureKind('EADDRINUSE: port 3000 already in use')).toBe('harness_fault');
    expect(classifyFailureKind('address already in use')).toBe('harness_fault');
  });

  test('SSH failures are harness_fault', () => {
    expect(classifyFailureKind('ssh connection timeout')).toBe('harness_fault');
    expect(classifyFailureKind('SSH refused by remote host')).toBe('harness_fault');
  });

  test('Docker daemon issues are harness_fault', () => {
    expect(classifyFailureKind('Docker daemon not running')).toBe('harness_fault');
    expect(classifyFailureKind('Cannot connect to the Docker daemon')).toBe('harness_fault');
  });

  test('timeout in staging is harness_fault', () => {
    expect(classifyFailureKind('Build timed out after 120s', 'staging')).toBe('harness_fault');
    expect(classifyFailureKind('timeout waiting for container', 'staging')).toBe('harness_fault');
  });

  test('timeout outside staging is not harness_fault', () => {
    // Timeout without staging source — could be app or infra
    expect(classifyFailureKind('timeout waiting for response')).not.toBe('harness_fault');
  });

  // --- APP FAILURES ---

  test('SyntaxError in staging is app_failure', () => {
    expect(classifyFailureKind('SyntaxError: Unexpected token )', 'staging')).toBe('app_failure');
  });

  test('SyntaxError in post_deploy is app_failure', () => {
    expect(classifyFailureKind('SyntaxError: Unexpected token', 'post_deploy_evidence')).toBe('app_failure');
  });

  test('SyntaxError in f9_gate is app_failure', () => {
    expect(classifyFailureKind('parse error: unterminated string', 'f9_gate')).toBe('app_failure');
  });

  test('SyntaxError without source is unknown', () => {
    expect(classifyFailureKind('SyntaxError: Unexpected token')).toBe('unknown');
  });

  test('build failure in staging is app_failure', () => {
    expect(classifyFailureKind('Docker build failed at step 4', 'staging')).toBe('app_failure');
    expect(classifyFailureKind('compilation failed with 3 errors', 'staging')).toBe('app_failure');
  });

  test('DB constraint violations are app_failure', () => {
    expect(classifyFailureKind('duplicate key value violates unique constraint')).toBe('app_failure');
    expect(classifyFailureKind('foreign key constraint violated')).toBe('app_failure');
    expect(classifyFailureKind('not-null constraint on column name')).toBe('app_failure');
  });

  test('predicate failures are app_failure', () => {
    expect(classifyFailureKind('predicate failed: color mismatch')).toBe('app_failure');
    expect(classifyFailureKind('BROWSER GATE FAILED: evidence FAILED')).toBe('app_failure');
    expect(classifyFailureKind('CSS value mismatch on .header')).toBe('app_failure');
  });

  test('selector not found is app_failure', () => {
    expect(classifyFailureKind('Element not found in DOM: .missing-class')).toBe('app_failure');
    expect(classifyFailureKind('selector not found: #header')).toBe('app_failure');
  });

  test('edit application failures are app_failure', () => {
    expect(classifyFailureKind('search string not found in server.js')).toBe('app_failure');
    expect(classifyFailureKind('Edit application failed: no match')).toBe('app_failure');
  });

  test('missing module is app_failure', () => {
    expect(classifyFailureKind('Cannot find module ./utils')).toBe('app_failure');
    expect(classifyFailureKind('MODULE_NOT_FOUND: express')).toBe('app_failure');
  });

  // --- UNKNOWN ---

  test('empty error is unknown', () => {
    expect(classifyFailureKind('')).toBe('unknown');
  });

  test('unrecognized error is unknown', () => {
    expect(classifyFailureKind('Something completely unexpected happened')).toBe('unknown');
  });

  test('docker compose exit is unknown (could be either)', () => {
    expect(classifyFailureKind('docker compose exited with code 1')).toBe('unknown');
  });

  // --- PRIORITY ORDER ---

  test('DNS takes priority over timeout', () => {
    // Error containing both DNS and timeout keywords
    expect(classifyFailureKind('getaddrinfo EAI_AGAIN db — timed out')).toBe('harness_fault');
  });

  test('port conflict takes priority over build failure', () => {
    expect(classifyFailureKind('build failed: EADDRINUSE port 3000')).toBe('harness_fault');
  });
});
