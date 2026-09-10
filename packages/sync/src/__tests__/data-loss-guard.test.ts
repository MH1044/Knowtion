import { describe, expect, it } from 'vitest';

import { checkDataLoss } from '../data-loss-guard.js';

describe('the data-loss circuit breaker', () => {
  it('allows ordinary editing, including sizeable deletions', () => {
    // A guard that fires during normal use gets switched off, and then protects nothing.
    expect(checkDataLoss(100, 99).safe).toBe(true);
    expect(checkDataLoss(100, 50).safe).toBe(true);
    expect(checkDataLoss(100, 20).safe).toBe(true);
  });

  it('allows growth', () => {
    expect(checkDataLoss(10, 500).safe).toBe(true);
  });

  it('refuses a transition that removes almost everything', () => {
    const verdict = checkDataLoss(100, 5);
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toMatch(/95 of 100/);
  });

  it('refuses total destruction', () => {
    expect(checkDataLoss(1000, 0).safe).toBe(false);
  });

  it('leaves small workspaces alone, where proportions mean nothing', () => {
    // Going from three pages to none is 100%, and is also just someone tidying up.
    // Protecting that case is impossible without making the rule useless.
    expect(checkDataLoss(3, 0).safe).toBe(true);
    expect(checkDataLoss(9, 0).safe).toBe(true);
    expect(checkDataLoss(10, 0).safe).toBe(false);
  });

  it('explains itself in terms a person can act on', () => {
    const reason = checkDataLoss(200, 0).reason ?? '';
    expect(reason).toMatch(/200 pages/);
    expect(reason).toMatch(/local notes are unchanged/i);
  });

  it('honours a stricter threshold when one is given', () => {
    expect(checkDataLoss(100, 40).safe).toBe(true);
    expect(checkDataLoss(100, 40, { threshold: 0.5 }).safe).toBe(false);
  });
});
