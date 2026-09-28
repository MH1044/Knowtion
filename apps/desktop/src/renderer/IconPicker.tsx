/**
 * Choosing a page's emoji.
 *
 * A fixed grid rather than a full emoji browser. A browser needs the Unicode data, a
 * search index and skin-tone handling, and none of that is what makes a sidebar
 * readable — a few dozen recognisable shapes is. Any emoji still reaches a page through
 * the text box, which accepts whatever the operating system's own picker pastes in.
 */
import { useEffect, useRef, useState } from 'react';

const CHOICES = [
  '📄',
  '📝',
  '📔',
  '📚',
  '🗂️',
  '📌',
  '📎',
  '🔖',
  '✅',
  '📅',
  '⏰',
  '🎯',
  '🚀',
  '💡',
  '🔥',
  '⭐',
  '🐛',
  '🔧',
  '⚙️',
  '🧪',
  '📈',
  '💰',
  '🏠',
  '🧭',
  '🌱',
  '🌍',
  '☕',
  '🎵',
  '🎨',
  '🍿',
  '❤️',
  '😀',
];

/**
 * The grid and the paste box, without the button that opens them. Shared by the page
 * icon and a callout's icon, which open it from different places.
 */
export function IconMenu({
  icon,
  onChoose,
}: {
  icon: string | undefined;
  /** Undefined removes the icon. */
  onChoose: (icon: string | undefined) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  return (
    <div className="icon-menu" role="dialog" aria-label="Choose an icon">
      <div className="icon-grid">
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-label={choice}
            onClick={() => {
              onChoose(choice);
            }}
          >
            {choice}
          </button>
        ))}
      </div>
      <div className="icon-custom">
        <input
          value={draft}
          placeholder="Or paste any emoji"
          aria-label="Custom icon"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            const trimmed = draft.trim();
            if (trimmed !== '') onChoose(trimmed);
          }}
        />
        <button
          type="button"
          disabled={icon === undefined}
          onClick={() => {
            onChoose(undefined);
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export function IconPicker({
  icon,
  onChange,
}: {
  icon: string | undefined;
  onChange: (icon: string | undefined) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else, which is what every other picker in the app does
  // and what a person expects from something that opened over the page.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const choose = (next: string | undefined) => {
    setOpen(false);
    onChange(next);
  };

  return (
    <div className="icon-picker" ref={container}>
      <button
        type="button"
        className="icon-button"
        aria-label={icon === undefined ? 'Add an icon' : 'Change the icon'}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        {icon ?? <span className="icon-empty">+</span>}
      </button>

      {open && <IconMenu icon={icon} onChoose={choose} />}
    </div>
  );
}

/**
 * The icon menu opened from a callout's icon, at the icon's position. Closes on a click
 * anywhere else, like the page icon's.
 */
export function FloatingIconMenu({
  left,
  top,
  icon,
  onChoose,
  onClose,
}: {
  left: number;
  top: number;
  icon: string | undefined;
  onChoose: (icon: string | undefined) => void;
  onClose: () => void;
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);
  return (
    <div ref={container} className="floating-icon-menu" style={{ left, top }}>
      <IconMenu icon={icon} onChoose={onChoose} />
    </div>
  );
}
