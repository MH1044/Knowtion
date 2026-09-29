import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { placePopover, type Box, type Placement, type PlaceOptions } from './placement.js';
import './Popover.css';

/** What a popover opens from: an element, such as the button that opened it, or a box. */
export type PopoverAnchor = Element | Box;

export type CloseReason = 'outside' | 'escape' | 'blur';

/**
 * The popover a nested one opens inside. A submenu's element sits inside its menu's, so
 * a click in the submenu is not a click outside the menu, and focus in it is still focus
 * in the menu.
 */
const Layer = createContext<RefObject<HTMLDivElement | null> | null>(null);

function anchorBox(anchor: PopoverAnchor): Box {
  return anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
}

function samePlace(a: Placement | null, b: Placement): boolean {
  return a !== null && a.left === b.left && a.top === b.top && a.maxHeight === b.maxHeight;
}

/**
 * Something opened over the page, next to what opened it: a menu, a picker.
 *
 * It closes on a click outside it (not on its anchor, whose own click decides), on Escape
 * and when the window loses focus, and on closing gives focus back to where it was when it
 * opened, unless focus has already gone somewhere else on purpose. `returnFocus` names
 * somewhere else to go back to, such as the editor for a menu opened from a button.
 */
export function Popover({
  anchor,
  onClose,
  side,
  minHeight,
  bounds,
  maxHeight = 360,
  returnFocus,
  className,
  role,
  label,
  children,
}: {
  anchor: PopoverAnchor;
  onClose: (reason: CloseReason) => void;
  side?: PlaceOptions['side'];
  minHeight?: number | undefined;
  bounds?: PlaceOptions['bounds'];
  /** The tallest it gets anywhere; the content scrolls beyond it. */
  maxHeight?: number | undefined;
  returnFocus?: HTMLElement | (() => void) | undefined;
  className?: string | undefined;
  role?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
}): React.JSX.Element {
  const parent = useContext(Layer);
  const element = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  // Only so a window resize renders, and so measures, again.
  const [, setResized] = useState(0);
  // Read while rendering, before a child such as a menu moves focus into the popover.
  const [cameFrom] = useState(() => document.activeElement);
  const latest = useRef({ anchor, onClose, returnFocus });
  useLayoutEffect(() => {
    latest.current = { anchor, onClose, returnFocus };
  });

  // Measured after every render, since what it holds can change; it only renders again
  // when the answer changes, so this settles at once.
  useLayoutEffect(() => {
    const el = element.current;
    if (el === null) return;
    // scrollHeight is the content's own height whatever maxHeight is now; the rest is
    // the border.
    const natural = el.scrollHeight + el.offsetHeight - el.clientHeight;
    const next = placePopover(
      anchorBox(anchor),
      { width: el.offsetWidth, height: Math.min(maxHeight, natural) },
      { width: window.innerWidth, height: window.innerHeight },
      { side, minHeight, bounds },
    );
    setPlace((previous) => (samePlace(previous, next) ? previous : next));
  });

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || element.current?.contains(target) === true) return;
      const from = latest.current.anchor;
      if (from instanceof Element && from.contains(target)) return;
      latest.current.onClose('outside');
    };
    // Escape reaches here only when focus is outside the popover: inside, the handler on
    // the popover itself takes it first, so the topmost of two nested ones closes alone.
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') latest.current.onClose('escape');
    };
    const blur = (): void => {
      latest.current.onClose('blur');
    };
    const resize = (): void => {
      setResized((n) => n + 1);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', resize);
    };
  }, []);

  useLayoutEffect(() => {
    const el = element.current;
    return () => {
      // A click on something else that takes focus keeps it; focus left inside the
      // popover, or dropped when an element went away, goes back.
      const active = document.activeElement;
      if (active !== null && active !== document.body && el?.contains(active) !== true) return;
      const to = latest.current.returnFocus ?? cameFrom;
      if (typeof to === 'function') to();
      else if (to instanceof HTMLElement && to.isConnected) to.focus({ preventScroll: true });
    };
  }, [cameFrom]);

  const popover = (
    <div
      ref={element}
      className={`popover${place === null ? ' placing' : ''}${className === undefined ? '' : ` ${className}`}`}
      role={role}
      aria-label={label}
      style={place === null ? undefined : { ...place }}
      onKeyDown={(e) => {
        // Keys pressed in a popover are its own: the page under it must not act on them.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose('escape');
        }
      }}
    >
      <Layer.Provider value={element}>{children}</Layer.Provider>
    </div>
  );
  return createPortal(popover, parent?.current ?? document.body);
}
