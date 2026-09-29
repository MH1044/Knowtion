import { describe, expect, it } from 'vitest';

import {
  addToast,
  makeToast,
  MAX_TOASTS,
  removeToast,
  TOAST_MS,
  TOAST_WITH_ACTION_MS,
  type Toast,
} from '../toastQueue.js';

const undo = { label: 'Undo', run: () => undefined };

describe('the toast queue', () => {
  it('shows a plain message for a few seconds, and one with a button for longer', () => {
    expect(makeToast(1, { message: 'Saved' }).duration).toBe(TOAST_MS);
    expect(makeToast(2, { message: 'Deleted', action: undo }).duration).toBe(TOAST_WITH_ACTION_MS);
    expect(TOAST_WITH_ACTION_MS).toBeGreaterThan(TOAST_MS);
  });

  it('keeps a duration it is given', () => {
    expect(makeToast(1, { message: 'Hi', action: undo, duration: 1000 }).duration).toBe(1000);
  });

  it('adds the newest last', () => {
    const queue = addToast(
      addToast([], makeToast(1, { message: 'a' })),
      makeToast(2, { message: 'b' }),
    );
    expect(queue.map((t) => t.id)).toEqual([1, 2]);
  });

  it('drops the oldest when full', () => {
    let queue: readonly Toast[] = [];
    for (let id = 1; id <= MAX_TOASTS + 2; id++) {
      queue = addToast(queue, makeToast(id, { message: String(id) }));
    }
    expect(queue.map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it('removes a toast by id, and leaves the queue as it is for an unknown one', () => {
    const queue = addToast(
      addToast([], makeToast(1, { message: 'a' })),
      makeToast(2, { message: 'b' }),
    );
    expect(removeToast(queue, 1).map((t) => t.id)).toEqual([2]);
    expect(removeToast(queue, 9)).toBe(queue);
  });
});
