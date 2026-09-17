/**
 * Display settings: the choices that belong to this device rather than to the workspace.
 *
 * Deliberately small and deliberately not synced. Everything here changes what one person
 * sees on one machine, which is exactly the class FORMAT.md section 10 keeps out of the
 * operation log, so it all lives in `localStorage` through `preferences.ts`.
 */
import {
  COLUMN_TOGGLES_KEY,
  COLUMN_TOGGLE_PLACES,
  usePreference,
  type ColumnTogglePlace,
} from './preferences.js';

export function Settings(): React.JSX.Element {
  const [columnToggles, setColumnToggles] = usePreference<ColumnTogglePlace>(
    COLUMN_TOGGLES_KEY,
    COLUMN_TOGGLE_PLACES,
    'view',
  );

  return (
    <details className="settings">
      <summary>Settings</summary>
      <label>
        <span>Show and hide columns from</span>
        <select
          value={columnToggles}
          aria-label="Where column toggles appear"
          onChange={(e) => {
            setColumnToggles(e.target.value as ColumnTogglePlace);
          }}
        >
          <option value="view">the Filter &amp; sort panel</option>
          <option value="properties">the Properties panel</option>
        </select>
      </label>
    </details>
  );
}
