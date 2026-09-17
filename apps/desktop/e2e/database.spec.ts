/**
 * End-to-end: a page becomes a database, gets a schema, a row, a value, and a board.
 *
 * The unit tests prove the engine, the read model and the host each do their part; this
 * drives the real app through the real IPC and asserts what a person would see. The
 * failure it exists to catch is a wiring one — a channel not registered, a push event
 * not reaching the table, a cell that commits nothing — which no unit test can.
 */
import { expect, test } from '@playwright/test';

import { launchFreshApp } from './helpers.js';

test('a database can be built, filled and viewed as a board from the UI alone', async () => {
  const { window, close } = await launchFreshApp();

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
    await window.getByRole('button', { name: 'New row', exact: true }).click();
    const rowTitle = window.getByRole('textbox', { name: 'Row title' });
    await expect(rowTitle).toHaveCount(1);
    await rowTitle.fill('Write the spec');
    await rowTitle.press('Enter');
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

    // A board grouped by Status shows the card in the Doing column.
    await window.getByRole('button', { name: 'New view' }).click();
    await window.getByRole('textbox', { name: 'View name' }).fill('Board');
    await window.getByRole('combobox', { name: 'View type' }).selectOption('board');
    await window.getByRole('combobox', { name: 'Group by' }).selectOption({ label: 'Status' });
    await window.getByRole('button', { name: 'Add', exact: true }).click();
    const doing = window.getByRole('listitem', { name: 'Doing' });
    await expect(doing).toBeVisible();
    await expect(doing.getByRole('button', { name: 'Write the spec' })).toBeVisible();
    await expect(window.getByRole('listitem', { name: 'No Status' })).toBeVisible();
  } finally {
    await close();
  }
});
