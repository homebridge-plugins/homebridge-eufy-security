import { describe, expect, it } from 'vitest';

import { DeclaredMediaSessionBudget } from '../../src/media/session-budget.js';

/**
 * The declared ceiling on concurrent media work, and the guarantees admission control depends on.
 *
 * Every unit counted here is one SDK pull and at least one adaptation process, whether it serves a live
 * session or a fresh still. The budget only ever answers whether there is room; it holds no reference to the
 * work it admitted and therefore cannot end any of it, which is what keeps a refusal from being able to
 * interrupt someone already watching.
 */
describe('declared media session budget', () => {
  it('admits without counting when no ceiling was declared', () => {
    const budget = new DeclaredMediaSessionBudget(0);
    const claims = Array.from({ length: 64 }, () => budget.claim());

    expect(
      claims.every((claim) => claim !== undefined),
      'an installation that declared nothing has to behave exactly as it did before the setting existed',
    ).toBe(true);
  });

  it('admits up to the declared ceiling and refuses the next', () => {
    const budget = new DeclaredMediaSessionBudget(2);

    expect(budget.claim()).toBeDefined();
    expect(budget.claim()).toBeDefined();
    expect(budget.claim(), 'the ceiling is a ceiling, not a target').toBeUndefined();
  });

  it('recovers capacity as work ends, without any reset', () => {
    const budget = new DeclaredMediaSessionBudget(1);
    const held = budget.claim();

    expect(budget.claim()).toBeUndefined();
    held!.release();

    expect(budget.claim(), 'a bounded host has to admit again once load falls, with no restart').toBeDefined();
  });

  it('leaves an admitted claim valid while it is refusing others', () => {
    const budget = new DeclaredMediaSessionBudget(1);
    const established = budget.claim();

    expect(budget.claim()).toBeUndefined();
    expect(
      established,
      'nothing about being at capacity may withdraw what was already admitted, or a viewer loses their picture',
    ).toBeDefined();
    established!.release();
    expect(budget.claim()).toBeDefined();
  });

  it('counts one release per claim however often release is called', () => {
    const budget = new DeclaredMediaSessionBudget(1);
    const held = budget.claim();
    held!.release();
    held!.release();
    held!.release();

    const next = budget.claim();
    expect(next, 'the freed slot is real').toBeDefined();
    expect(
      budget.claim(),
      'a session released twice must not hand the host a slot it does not have; every teardown path releases',
    ).toBeUndefined();
  });
});
