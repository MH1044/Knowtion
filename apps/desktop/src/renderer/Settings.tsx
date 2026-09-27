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
  UPDATE_CHECKS,
  UPDATE_CHECK_KEY,
  usePreference,
  type ColumnTogglePlace,
  type UpdateChecks,
} from './preferences.js';

export function Settings(): React.JSX.Element {
  const [columnToggles, setColumnToggles] = usePreference<ColumnTogglePlace>(
    COLUMN_TOGGLES_KEY,
    COLUMN_TOGGLE_PLACES,
    'view',
  );

  const [updateChecks, setUpdateChecks] = usePreference<UpdateChecks>(
    UPDATE_CHECK_KEY,
    UPDATE_CHECKS,
    'on',
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
      <label>
        <span>Check for new versions</span>
        <select
          value={updateChecks}
          aria-label="Check for new versions"
          onChange={(e) => {
            setUpdateChecks(e.target.value as UpdateChecks);
          }}
        >
          <option value="on">on startup</option>
          <option value="off">never</option>
        </select>
      </label>
      <p className="settings-note">
        The version check is the only request Knowtion makes on its own. It asks the public releases
        page what the latest version is and sends nothing about you or your notes.
      </p>
    </details>
  );
}
