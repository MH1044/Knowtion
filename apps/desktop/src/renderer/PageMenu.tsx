import { useState } from 'react';

import { api, type Page } from './api.js';
import { Menu, type MenuEntry } from './ui/Menu.js';
import './PageMenu.css';

/** What the page menu's entries do, one each. */
export interface PageActions {
  turnIntoDatabase: () => void;
  turnBackIntoPage: () => void;
  moveToTrash: () => void;
}

/**
 * The ••• menu's entries: a page turns into a database and a database back into a page,
 * then either goes to the trash. A database row opened as a page is a page here, as it was
 * when these were buttons under the title.
 */
export function pageMenuItems(page: Pick<Page, 'database'>, actions: PageActions): MenuEntry[] {
  return [
    page.database === undefined
      ? { id: 'to-database', label: 'Turn into database', onSelect: actions.turnIntoDatabase }
      : { id: 'to-page', label: 'Turn back into a page', onSelect: actions.turnBackIntoPage },
    { kind: 'separator', id: 'separator' },
    { id: 'trash', label: 'Move to trash', danger: true, onSelect: actions.moveToTrash },
  ];
}

const RETIRE_QUESTION =
  'Turn this database back into a page? The rows become child pages. ' +
  'Nothing is deleted — turning it into a database again brings the columns and values back.';

/**
 * The ••• at the top right of the page, opening what can be done to the page as a whole,
 * as Notion keeps it there. `onArchived` runs once the page is in the trash.
 */
export function PageMenu({
  page,
  run,
  onArchived,
}: {
  page: Page;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onArchived: () => void;
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ button: HTMLElement; fromKeyboard: boolean } | null>(null);

  const actions: PageActions = {
    turnIntoDatabase: () => void run(() => api.dbConvert(page.id)),
    turnBackIntoPage: () => {
      // Worth a question: the table, its views and every column vanish from view at once.
      // They are all still there, which is what the wording says. Asked on the next tick:
      // the menu closes and acts in the same one, and a dialog opened straight away would
      // have the menu still drawn behind it.
      setTimeout(() => {
        if (window.confirm(RETIRE_QUESTION)) void run(() => api.dbRetire(page.id));
      }, 0);
    },
    moveToTrash: () =>
      void run(async () => {
        await api.archivePage(page.id);
        onArchived();
      }),
  };

  return (
    <>
      <button
        type="button"
        className="nav-button page-menu-button"
        aria-label="Page options"
        title="Page options"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(e) => {
          // A click from Enter or Space has no pointer behind it (detail 0). A second click
          // closes the menu: the menu leaves clicks on this button to the button.
          setMenu(menu === null ? { button: e.currentTarget, fromKeyboard: e.detail === 0 } : null);
        }}
      >
        •••
      </button>
      {menu !== null && (
        <Menu
          anchor={menu.button}
          label="Page options"
          items={pageMenuItems(page, actions)}
          initialActive={menu.fromKeyboard ? 'first' : 'none'}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </>
  );
}
