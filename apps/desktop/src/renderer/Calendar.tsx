import { useEffect, useMemo, useRef, useState } from 'react';

import type { CalendarDate } from '@knowtion/engine/properties';

import { firstDayOfWeek, localToday, monthGrid, monthTitle, weekdayNames } from './dates.js';
import './Calendar.css';

export interface CalendarPoint {
  left: number;
  top: number;
}

/** The month a calendar opens on: the value's, or this month's when there is none. */
export function openingMonth(
  value: string | undefined,
  today: CalendarDate,
): { year: number; month: number } {
  const from = value !== undefined && /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value) ? value : today;
  const [year, month] = from.split('-').map(Number);
  return { year: year ?? 2026, month: month ?? 1 };
}

/** Where a calendar opens for something on the page: just under it, as a date chip asks. */
export function underRect(rect: { left: number; bottom: number }): CalendarPoint {
  return { left: rect.left, top: rect.bottom + 4 };
}

const HEIGHT = 300;
const WIDTH = 260;

/** Kept inside the window: a date near the bottom of the page opens its calendar above. */
export function placeCalendar(
  at: CalendarPoint,
  viewport: { width: number; height: number },
): CalendarPoint {
  return {
    left: Math.min(at.left, viewport.width - WIDTH),
    top: at.top + HEIGHT > viewport.height ? Math.max(4, at.top - HEIGHT - 32) : at.top,
  };
}

/**
 * A month calendar for choosing a date. Opens on the month of the current value, or on
 * this month with nothing chosen when there is none, and closes on a choice, on Escape,
 * or on a click anywhere else. Clear is offered only where a date can be taken away.
 */
export function Calendar({
  left,
  top,
  value,
  onPick,
  onClear,
  onClose,
  anchor,
}: {
  left: number;
  top: number;
  value?: string | undefined;
  onPick: (date: CalendarDate) => void;
  onClear?: (() => void) | undefined;
  onClose: () => void;
  /**
   * What opened the calendar. A press on it is not a click elsewhere: its own click
   * decides, so a second click on it closes the calendar rather than reopening it.
   */
  anchor?: Element | null | undefined;
}): React.JSX.Element {
  const today = localToday();
  const [shown, setShown] = useState(() => openingMonth(value, today));
  const firstDay = useMemo(() => firstDayOfWeek(), []);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchor?.contains(target)) return;
      if (!container.current?.contains(target)) onClose();
    };
    // Before anything on the page sees the key, and marked as handled: a date chip's
    // calendar leaves the editor focused, and the editor would otherwise also take this
    // Escape and select the chip's block.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, anchor]);

  const step = (by: number) => {
    setShown(({ year: y, month: m }) => {
      const index = y * 12 + (m - 1) + by;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    });
  };

  const placed = placeCalendar(
    { left, top },
    { width: window.innerWidth, height: window.innerHeight },
  );

  return (
    <div
      ref={container}
      className="calendar"
      role="dialog"
      aria-label="Choose a date"
      style={{ left: placed.left, top: placed.top }}
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      <div className="calendar-head">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => {
            step(-1);
          }}
        >
          ‹
        </button>
        <span>{monthTitle(shown.year, shown.month)}</span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => {
            step(1);
          }}
        >
          ›
        </button>
      </div>
      <div className="calendar-grid" role="grid">
        {weekdayNames(firstDay).map((name, i) => (
          <span key={i} className="calendar-weekday">
            {name}
          </span>
        ))}
        {monthGrid(shown.year, shown.month, firstDay)
          .flat()
          .map((day) => (
            <button
              key={day.date}
              type="button"
              className={[
                'calendar-day',
                day.inMonth ? '' : 'outside',
                day.date === value ? 'chosen' : '',
                day.date === today ? 'today' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={day.date}
              aria-pressed={day.date === value}
              onClick={() => {
                onPick(day.date);
              }}
            >
              {Number(day.date.slice(8))}
            </button>
          ))}
      </div>
      <div className="calendar-foot">
        {onClear !== undefined && (
          <button type="button" className="calendar-clear" onClick={onClear}>
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            onPick(today);
          }}
        >
          Today
        </button>
      </div>
    </div>
  );
}
