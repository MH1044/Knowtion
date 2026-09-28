import { useEffect, useMemo, useRef, useState } from 'react';

import type { CalendarDate } from '@knowtion/engine/properties';

import { firstDayOfWeek, localToday, monthGrid, monthTitle, weekdayNames } from './dates.js';

/**
 * A month calendar for choosing a date. Opens on the month of the current value, and
 * closes on a choice, on Escape, or on a click anywhere else.
 */
export function Calendar({
  left,
  top,
  value,
  onPick,
  onClose,
}: {
  left: number;
  top: number;
  value: CalendarDate;
  onPick: (date: CalendarDate) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [year, month] = value.split('-').map(Number);
  const [shown, setShown] = useState({ year: year ?? 2026, month: month ?? 1 });
  const today = localToday();
  const firstDay = useMemo(() => firstDayOfWeek(), []);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const step = (by: number) => {
    setShown(({ year: y, month: m }) => {
      const index = y * 12 + (m - 1) + by;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    });
  };

  // Kept inside the window: a date near the bottom of the page opens its calendar above.
  const height = 300;
  const placedTop = top + height > window.innerHeight ? Math.max(4, top - height - 32) : top;
  const placedLeft = Math.min(left, window.innerWidth - 260);

  return (
    <div
      ref={container}
      className="calendar"
      role="dialog"
      aria-label="Choose a date"
      style={{ left: placedLeft, top: placedTop }}
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
