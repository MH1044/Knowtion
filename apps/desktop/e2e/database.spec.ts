/**
 * End-to-end: a page becomes a database, gets a schema, rows, values, an order and a board.
 *
 * The unit tests prove the engine, the read model and the host each do their part; this
 * drives the real app through the real IPC and asserts what a person would see. The
 * failure it exists to catch is a wiring one — a channel not registered, a push event not
 * reaching the table, a cell that commits nothing, a drop that computes a position and
 * never sends it — which no unit test can.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { dragOnto, findPacks, flush, launchFreshApp, topEdgeOf } from './helpers.js';

test('a database can be built, filled, reordered and viewed as a board from the UI alone', async () => {
  const { window, profile, close } = await launchFreshApp();

  try {
    await window.getByRole('button', { name: 'New page' }).click();
    const title = window.getByRole('textbox', { name: 'Page title' });
    await expect(title).toBeVisible();
    await title.fill('Tasks');
    await title.press('Enter');

    await window.getByRole('button', { name: 'Turn into database' }).click();
    // The default table view is created with the database.
    await expect(window.getByRole('tab', { name: 'Table' })).toBeVisible();
    await expect(window.getByRole('grid', { name: 'Table' })).toBeVisible();

    // Schema: a text property and a select property with one option.
    await window.getByRole('button', { name: 'Properties' }).click();
    const newName = window.getByRole('textbox', { name: 'New property name' });
    await newName.fill('Owner');
    await window.getByRole('button', { name: 'Add property' }).click();
    await expect(window.getByRole('columnheader', { name: 'Owner' })).toBeVisible();

    await newName.fill('Status');
    await window.getByRole('combobox', { name: 'New property type' }).selectOption('select');
    await window.getByRole('button', { name: 'Add property' }).click();
    await expect(window.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    const newOption = window.getByRole('textbox', { name: 'New option for Status' });
    await newOption.fill('Doing');
    await newOption.press('Enter');
    await expect(window.getByRole('textbox', { name: 'Option name' })).toHaveValue('Doing');
    await window.getByRole('button', { name: 'Properties' }).click();

    // A row, with a value typed into the text cell and committed on Enter.
    const rowTitles = window.getByRole('textbox', { name: 'Row title' });
    await window.getByRole('button', { name: 'New row', exact: true }).click();
    await expect(rowTitles).toHaveCount(1);
    await rowTitles.fill('Write the spec');
    await rowTitles.press('Enter');
    const owner = window.getByRole('textbox', { name: 'Owner' });
    await owner.fill('Ada');
    await owner.press('Enter');
    await expect(owner).toHaveValue('Ada');

    // The select cell offers the option we added.
    await window.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Doing' });
    await expect(window.getByRole('combobox', { name: 'Status' })).toHaveValue(/.+/);

    // Open the row as a page: its properties sit above the body, with a way back.
    await window.getByRole('button', { name: 'Open as a page' }).click();
    await expect(window.getByRole('textbox', { name: 'Page title' })).toHaveValue('Write the spec');
    await expect(window.getByRole('region', { name: 'Properties' })).toBeVisible();
    await expect(window.getByRole('textbox', { name: 'Owner' })).toHaveValue('Ada');
    await window.getByRole('button', { name: '← Tasks' }).click();
    await expect(window.getByRole('grid', { name: 'Table' })).toBeVisible();

    // A second row, so there is an order to change.
    await window.getByRole('button', { name: '+ New row' }).click();
    await expect(rowTitles).toHaveCount(2);
    await rowTitles.nth(1).fill('Ship it');
    await rowTitles.nth(1).press('Enter');
    await expect(rowTitles.nth(0)).toHaveValue('Write the spec');

    // Drag the second row above the first. The handle is offered only because this view
    // has no sort and no grouping, which is the one case a manual order means anything.
    const rows = window.locator('.db-table tbody tr[data-row]');
    await dragOnto(
      window,
      rows.nth(1).locator('.drag-handle'),
      window.locator('.db-table tbody'),
      await topEdgeOf(rows.nth(0)),
    );
    await expect(rowTitles.nth(0)).toHaveValue('Ship it');
    await expect(rowTitles.nth(1)).toHaveValue('Write the spec');

    // A board grouped by Status sorts the rows into the option's column and a column for
    // the rows with no value at all.
    await window.getByRole('button', { name: 'New view' }).click();
    await window.getByRole('textbox', { name: 'View name' }).fill('Board');
    await window.getByRole('combobox', { name: 'View type' }).selectOption('board');
    await window.getByRole('combobox', { name: 'Group by' }).selectOption({ label: 'Status' });
    await window.getByRole('button', { name: 'Add', exact: true }).click();
    const doing = window.getByRole('listitem', { name: 'Doing' });
    const noStatus = window.getByRole('listitem', { name: 'No Status' });
    await expect(doing.getByRole('button', { name: 'Write the spec' })).toBeVisible();
    await expect(noStatus.getByRole('button', { name: 'Ship it' })).toBeVisible();

    // Drag the card to the other column. One commit both clears the property and places
    // the card, so a card arriving under "No Status" is the proof the value went with it.
    await dragOnto(window, doing.locator('.card'), noStatus, await topEdgeOf(noStatus));
    await expect(noStatus.locator('.card')).toHaveCount(2);
    await expect(doing.locator('.card')).toHaveCount(0);

    // Everything above went through the engine, so it must be in the encrypted log.
    await flush(window);
    const packs = await findPacks(join(profile, 'log'));
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const bytes = await readFile(pack);
      // FORMAT.md section 3: magic at 0, suite_id at 6. 0x01 is XChaCha20-Poly1305.
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('KNOW');
      expect(bytes[6]).toBe(0x01);
    }
  } finally {
    await close();
  }
});
