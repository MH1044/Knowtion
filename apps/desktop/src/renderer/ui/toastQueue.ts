/** A button on a toast, such as Undo. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastSpec {
  message: string;
  action?: ToastAction | undefined;
  /** How long it shows, in milliseconds. */
  duration?: number | undefined;
}

export interface Toast {
  id: number;
  message: string;
  action: ToastAction | undefined;
  duration: number;
}

/** How long a toast shows. */
export const TOAST_MS = 5000;

/** Longer with a button, which takes a moment to find and reach. */
export const TOAST_WITH_ACTION_MS = 8000;

/** The most shown at once; a newer one pushes out the oldest. */
export const MAX_TOASTS = 3;

export function makeToast(id: number, spec: ToastSpec): Toast {
  const duration = spec.duration ?? (spec.action === undefined ? TOAST_MS : TOAST_WITH_ACTION_MS);
  return { id, message: spec.message, action: spec.action, duration };
}

/** The queue with `toast` added last, and the oldest dropped when it is full. */
export function addToast(
  queue: readonly Toast[],
  toast: Toast,
  max: number = MAX_TOASTS,
): readonly Toast[] {
  const next = [...queue, toast];
  return next.slice(Math.max(0, next.length - max));
}

/** The queue without the toast `id`; the same queue when it is not there. */
export function removeToast(queue: readonly Toast[], id: number): readonly Toast[] {
  return queue.some((t) => t.id === id) ? queue.filter((t) => t.id !== id) : queue;
}
