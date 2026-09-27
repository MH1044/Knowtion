/**
 * Properties and their options: add, rename, retype, remove.
 *
 * Retyping never converts a value. The engine hides values of the old shape until the
 * type changes back, so this says so where the choice is made rather than letting a
 * person discover it as a column that went blank.
 *
 * Anything passed as children is drawn below the list. That is how the column show-and-
 * hide checkboxes get here when someone has asked for them in this panel: they belong to
 * a view rather than to the schema, so this component stays unaware of views.
 */
import { useState } from 'react';

import { api, type DatabaseSchema, type PropertyType } from '../api.js';

const TYPES: { value: PropertyType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'select', label: 'Select' },
  { value: 'multi-select', label: 'Multi-select' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date and time' },
  { value: 'url', label: 'URL' },
];

/**
 * A name that can be edited here and renamed on another device at the same time.
 *
 * Uncontrolled inputs were simpler and wrong: a rename arriving mid-session never
 * appeared, because the DOM keeps whatever it was first given. This is the same
 * seen/draft guard the page title and the row title use — adopt an incoming name unless
 * the person has typed, in which case their draft stands until they commit it.
 */
function NameField({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (name: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (draft === seen) setDraft(value);
  }
  return (
    <input
      value={draft}
      aria-label={label}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      onBlur={() => {
        const name = draft.trim();
        if (name !== '' && name !== value) onCommit(name);
        else setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function SchemaEditor({
  databaseId,
  schema,
  run,
  children,
}: {
  databaseId: string;
  schema: DatabaseSchema;
  run: (action: () => Promise<unknown>) => Promise<void>;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<PropertyType>('text');
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});

  const addOption = (propertyId: string): void => {
    const name = (optionDrafts[propertyId] ?? '').trim();
    if (name === '') return;
    void run(() => api.dbAddOption(databaseId, propertyId, { name }));
    setOptionDrafts({ ...optionDrafts, [propertyId]: '' });
  };

  return (
    <section className="schema-editor" aria-label="Properties">
      <ul className="property-list">
        {schema.properties.map((property) => (
          <li key={property.id}>
            <NameField
              value={property.name}
              label="Property name"
              onCommit={(name) => {
                void run(() => api.dbUpdateProperty(databaseId, property.id, { name }));
              }}
            />
            <select
              value={property.type}
              aria-label={`Type of ${property.name}`}
              title="Values of the old type are hidden until the type is changed back."
              onChange={(e) => {
                void run(() =>
                  api.dbUpdateProperty(databaseId, property.id, {
                    type: e.target.value as PropertyType,
                  }),
                );
              }}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (window.confirm(`Remove the property "${property.name}" from every row?`)) {
                  void run(() => api.dbRemoveProperty(databaseId, property.id));
                }
              }}
            >
              Remove
            </button>
            {(property.type === 'select' || property.type === 'multi-select') && (
              <ul className="option-list">
                {property.options.map((option) => (
                  <li key={option.id}>
                    <NameField
                      value={option.name}
                      label="Option name"
                      onCommit={(name) => {
                        void run(() =>
                          api.dbUpdateOption(databaseId, property.id, option.id, { name }),
                        );
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`Remove option ${option.name}`}
                      onClick={() => {
                        void run(() => api.dbRemoveOption(databaseId, property.id, option.id));
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
                <li>
                  {/* Enter alone was the only way in, so a typed option was lost to a
                      stray click. The button makes the action visible and reachable. */}
                  <input
                    value={optionDrafts[property.id] ?? ''}
                    placeholder="New option"
                    aria-label={`New option for ${property.name}`}
                    onChange={(e) => {
                      setOptionDrafts({ ...optionDrafts, [property.id]: e.target.value });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addOption(property.id);
                      if (e.key === 'Escape') {
                        setOptionDrafts({ ...optionDrafts, [property.id]: '' });
                      }
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Add option to ${property.name}`}
                    disabled={(optionDrafts[property.id] ?? '').trim() === ''}
                    onClick={() => {
                      addOption(property.id);
                    }}
                  >
                    Add
                  </button>
                </li>
              </ul>
            )}
          </li>
        ))}
      </ul>
      <form
        className="add-property"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newName.trim();
          if (name === '') return;
          void run(() => api.dbDefineProperty(databaseId, { name, type: newType }));
          setNewName('');
        }}
      >
        <input
          value={newName}
          placeholder="New property"
          aria-label="New property name"
          onChange={(e) => {
            setNewName(e.target.value);
          }}
        />
        <select
          value={newType}
          aria-label="New property type"
          onChange={(e) => {
            setNewType(e.target.value as PropertyType);
          }}
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button type="submit">Add property</button>
      </form>
      <p className="schema-note">
        Changing a property&apos;s type hides its values until the type is changed back. Nothing is
        converted, and nothing is lost.
      </p>
      {children}
    </section>
  );
}
