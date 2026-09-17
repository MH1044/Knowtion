/**
 * A row's properties, shown above its body when the row is opened as a page.
 *
 * The schema belongs to the parent database and is fetched from it, because a row that
 * is opened from the table is not in the sidebar tree — rows are left out of it on
 * purpose — so the parent's page is not at hand.
 */
import { useEffect, useState } from 'react';

import { api, type DatabaseSchema, type Page } from '../api.js';
import { useWorkspaceChanges } from '../changes.js';
import { PropertyCell } from './PropertyCell.js';

export function RowProperties({
  page,
  run,
  onOpenParent,
}: {
  page: Page;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onOpenParent: (id: string) => void;
}): React.JSX.Element | null {
  const parentId = page.parentId;
  const [parent, setParent] = useState<{ title: string; schema: DatabaseSchema }>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (parentId === undefined) return;
    let cancelled = false;
    void Promise.all([api.page(parentId), api.dbSchema(parentId)]).then(([p, schema]) => {
      if (!cancelled && schema !== null) setParent({ title: p.title, schema });
    });
    return () => {
      cancelled = true;
    };
  }, [parentId, tick]);

  useWorkspaceChanges((change) => {
    if (
      parentId !== undefined &&
      (change.databases.length === 0 || change.databases.includes(parentId))
    ) {
      setTick((t) => t + 1);
    }
  });

  if (parentId === undefined || parent === undefined) return null;
  const values = page.properties ?? {};

  return (
    <section className="row-properties" aria-label="Properties">
      <button
        type="button"
        className="back-link"
        onClick={() => {
          onOpenParent(parentId);
        }}
      >
        ← {parent.title || 'Untitled'}
      </button>
      <dl>
        {parent.schema.properties.map((property) => (
          <div key={property.id} className="row-property">
            <dt>{property.name}</dt>
            <dd>
              <PropertyCell
                def={property}
                value={values[property.id]}
                onCommit={(value) => {
                  void run(() => api.dbSetValue(page.id, property.id, value));
                }}
                onAddOption={
                  property.type === 'select'
                    ? async (name) => (await api.dbAddOption(parentId, property.id, { name })).id
                    : undefined
                }
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
