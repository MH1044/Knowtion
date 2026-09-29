import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { addToast, makeToast, removeToast, type Toast, type ToastSpec } from './toastQueue.js';
import './Toast.css';

let queue: readonly Toast[] = [];
let nextId = 1;
let hosted = false;
const listeners = new Set<() => void>();

function publish(next: readonly Toast[]): void {
  if (next === queue) return;
  queue = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Show a message at the bottom of the window, with a button such as Undo if `action` is
 * given, for a few seconds. Returns a function that takes it away early.
 *
 * The first call puts the toasts' own host in the page, so a caller anywhere, inside React
 * or not, needs nothing mounted beforehand.
 */
export function showToast(spec: ToastSpec): () => void {
  if (!hosted) {
    hosted = true;
    const host = document.createElement('div');
    document.body.append(host);
    createRoot(host).render(<Toasts />);
  }
  const toast = makeToast(nextId++, spec);
  publish(addToast(queue, toast));
  return () => {
    dismissToast(toast.id);
  };
}

export function dismissToast(id: number): void {
  publish(removeToast(queue, id));
}

function Toasts(): React.JSX.Element {
  const toasts = useSyncExternalStore(subscribe, () => queue);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastView key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastView({ toast }: { toast: Toast }): React.JSX.Element {
  // Held while the pointer is over it, so reaching for Undo never races the timer; it
  // starts again in full when the pointer leaves.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return undefined;
    const timer = setTimeout(() => {
      dismissToast(toast.id);
    }, toast.duration);
    return () => {
      clearTimeout(timer);
    };
  }, [held, toast.id, toast.duration]);

  const { action } = toast;
  return (
    <div
      className="toast"
      onMouseEnter={() => {
        setHeld(true);
      }}
      onMouseLeave={() => {
        setHeld(false);
      }}
    >
      <span className="toast-message">{toast.message}</span>
      {action !== undefined && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            dismissToast(toast.id);
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => {
          dismissToast(toast.id);
        }}
      >
        ×
      </button>
    </div>
  );
}
