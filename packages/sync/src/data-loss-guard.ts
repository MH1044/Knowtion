/**
 * Refuse a state transition that would destroy most of what the user has.
 *
 * Taken from Joplin, which needed it after real data loss. Its sync inferred remote
 * deletions from absence, so a throttled response, a truncated listing, an expired
 * token or an unmounted drive were all indistinguishable from the user deleting
 * everything — and it obediently deleted everything locally.
 *
 * Knowtion's layout is meant to make that impossible: deletion is an explicit tombstone
 * and a listing is never truth (FORMAT.md section 9). This guard exists anyway, because
 * the reasoning that makes it unnecessary is exactly the reasoning that would be wrong
 * if there were a bug. It is the last thing between a defect in the merge path and
 * somebody's notes.
 *
 * It is a refusal, not a repair. When it fires, something is wrong that this code does
 * not understand, and the only safe action is to stop and tell a person.
 */

export interface DataLossGuardOptions {
  /**
   * Fraction of pages that may disappear in one transition before it is refused.
   *
   * 0.9 means losing 90% or more is refused. Deliberately loose: a user really can
   * delete a lot at once, and a guard that fires on ordinary use gets disabled.
   */
  threshold?: number;
  /**
   * Below this many pages, proportions are meaningless — going from 3 pages to 0 is
   * 100% but is also just someone tidying up. Small workspaces are not protected by
   * this rule, and could not be without making it useless.
   */
  minimumPages?: number;
}

export interface DataLossVerdict {
  safe: boolean;
  /** Present when refused; written to be shown to a person. */
  reason?: string;
}

const DEFAULTS: Required<DataLossGuardOptions> = {
  threshold: 0.9,
  minimumPages: 10,
};

/**
 * @param before how many pages existed before the transition
 * @param after how many would exist after it
 */
export function checkDataLoss(
  before: number,
  after: number,
  options: DataLossGuardOptions = {},
): DataLossVerdict {
  const { threshold, minimumPages } = { ...DEFAULTS, ...options };

  if (before < minimumPages) return { safe: true };
  if (after >= before) return { safe: true };

  const lost = before - after;
  const fraction = lost / before;
  if (fraction < threshold) return { safe: true };

  return {
    safe: false,
    reason:
      `Refusing to continue: this would remove ${lost} of ${before} pages ` +
      `(${Math.round(fraction * 100)}%). That is not something ordinary editing does, ` +
      'so Knowtion has stopped rather than apply it. Your local notes are unchanged.',
  };
}
