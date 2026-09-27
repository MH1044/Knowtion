/**
 * What a view is called, and getting rid of it.
 *
 * Views could be created and never renamed or removed, so a typo in a view name was
 * permanent and an experiment was forever. Both operations already existed on the bridge;
 * nothing called them.
 *
 * Deleting is guarded by the engine, which refuses to remove a database's last view. The
 * button is disabled rather than left to fail, because a disabled control explains itself
 * and an error message after the fact does not.
 */
import { useState } from 'react';

import type { ViewDef } from '../api.js';

export function ViewSettings({
  view,
  canDelete,
  onRename,
  onDelete,
}: {
  view: ViewDef;
  canDelete: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(view.name);
  const [seen, setSeen] = useState(view.name);
  if (view.name !== seen) {
    setSeen(view.name);
    if (draft === seen) setDraft(view.name);
  }

  return (
    <div className="view-settings" role="group" aria-label="View">
      <label>
        Name
        <input
          value={draft}
          aria-label="View name"
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onBlur={() => {
            const name = draft.trim();
            if (name !== '' && name !== view.name) onRename(name);
            else setDraft(view.name);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft(view.name);
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="danger"
        disabled={!canDelete}
        title={canDelete ? undefined : 'A database keeps at least one view.'}
        onClick={() => {
          if (window.confirm(`Delete the view "${view.name}"? Its rows are not affected.`)) {
            onDelete();
          }
        }}
      >
        Delete view
      </button>
    </div>
  );
}
