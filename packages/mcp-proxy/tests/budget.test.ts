/**
 * Budget Cap — Unit Tests
 */

import { describe, test, expect } from 'bun:test';
import { createBudgetState, checkBudget, recordCall, recordBlocked, remainingCalls } from '../src/budget.js';

describe('Budget Cap', () => {

  test('unlimited budget always allows', () => {
    const budget = createBudgetState();
    expect(checkBudget(budget).allowed).toBe(true);
    recordCall(budget);
    recordCall(budget);
    recordCall(budget);
    expect(checkBudget(budget).allowed).toBe(true);
    expect(remainingCalls(budget)).toBe(Infinity);
  });

  test('limited budget blocks at threshold', () => {
    const budget = createBudgetState(3);
    expect(checkBudget(budget).allowed).toBe(true);
    expect(remainingCalls(budget)).toBe(3);

    recordCall(budget);
    expect(checkBudget(budget).allowed).toBe(true);
    expect(remainingCalls(budget)).toBe(2);

    recordCall(budget);
    expect(checkBudget(budget).allowed).toBe(true);
    expect(remainingCalls(budget)).toBe(1);

    recordCall(budget);
    const result = checkBudget(budget);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('BUDGET EXCEEDED');
    expect(result.reason).toContain('3/3');
    expect(remainingCalls(budget)).toBe(0);
  });

  test('blocked calls do not consume budget', () => {
    const budget = createBudgetState(5);
    recordCall(budget);
    recordBlocked(budget);
    recordBlocked(budget);
    expect(budget.callCount).toBe(1);
    expect(budget.blockedCount).toBe(2);
    expect(remainingCalls(budget)).toBe(4);
  });

  test('budget of 1 allows exactly one call', () => {
    const budget = createBudgetState(1);
    expect(checkBudget(budget).allowed).toBe(true);
    recordCall(budget);
    expect(checkBudget(budget).allowed).toBe(false);
  });

  test('remainingCalls never goes negative', () => {
    const budget = createBudgetState(2);
    recordCall(budget);
    recordCall(budget);
    recordCall(budget); // over budget
    expect(remainingCalls(budget)).toBe(0);
  });

  test('initial state is clean', () => {
    const budget = createBudgetState(10);
    expect(budget.callCount).toBe(0);
    expect(budget.blockedCount).toBe(0);
    expect(budget.maxCalls).toBe(10);
  });
});
