/**
 * A date shown as text that opens the app's calendar under it: a date cell's editor, and
 * a filter's exact date. One picker everywhere, the same one a date in the text opens.
 *
 * The value stays the stored `YYYY-MM-DD` string throughout. A choice is the grid day's
 * own string, never parsed into a Date, which is how a zoneless day becomes the day before
 * west of UTC (FORMAT.md section 10).
 */
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { CalendarDate } from '@knowtion/engine/properties';

import { Calendar, underRect, type CalendarPoint } from '../Calendar.js';
import { formatDate } from './format.js';
import './DateButton.css';

interface Open {
  at: CalendarPoint;
  from: HTMLButtonElement;
}

export function DateButton({
  value,
  label,
  placeholder = '',
  onChange,
}: {
  /** The stored date, or '' for none. */
  value: string;
  label: string;
  /** Shown, muted, when there is no date. */
  placeholder?: string;
  /** A date, or null when Clear takes it away. Not called when nothing changes. */
  onChange: (date: CalendarDate | null) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState<Open>();
  const button = useRef<HTMLButtonElement>(null);
  const shown = value === '' ? '' : formatDate(value);

  // Stable, so the calendar does not resubscribe its listeners on every render. Focus goes
  // back to the button; a click elsewhere then moves it on to what was clicked.
  const close = useCallback(() => {
    setOpen(undefined);
    button.current?.focus({ preventScroll: true });
  }, []);

  const choose = (date: CalendarDate | null) => {
    close();
    if ((date ?? '') !== value) onChange(date);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={value === '' ? 'date-button empty' : 'date-button'}
        aria-label={shown === '' ? label : `${label}: ${shown}`}
        aria-haspopup="dialog"
        aria-expanded={open !== undefined}
        // A click, Enter or Space. A second one closes the calendar: the calendar leaves
        // presses on this button to this handler rather than taking them as a click away.
        onClick={(e) => {
          if (open !== undefined) close();
          else
            setOpen({
              at: underRect(e.currentTarget.getBoundingClientRect()),
              from: e.currentTarget,
            });
        }}
      >
        {shown === '' ? placeholder : shown}
      </button>
      {open !== undefined &&
        // Into the body, so a table's scrolling and stacking cannot clip or cover it.
        createPortal(
          <Calendar
            left={open.at.left}
            top={open.at.top}
            value={value === '' ? undefined : value}
            anchor={open.from}
            onPick={choose}
            onClear={() => {
              choose(null);
            }}
            onClose={close}
          />,
          document.body,
        )}
    </>
  );
}
