/**
 * Properties and their options: add, rename, retype, remove.
 *
 * Retyping never converts a value. The engine hides values of the old shape until the
 * type changes back, so this says so where the choice is made rather than letting a
 * person discover it as a column that went blank.
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

export function SchemaEditor({
  databaseId,
  schema,
  run,
}: {
  databaseId: string;
  schema: DatabaseSchema;
  run: (action: () => Promise<unknown>) => Promise<void>;
}): React.JSX.Element {
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<PropertyType>('text');
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});

  return (
    <section className="schema-editor" aria-label="Properties">
      <ul className="property-list">
        {schema.properties.map((property) => (
          <li key={property.id}>
            <input
              defaultValue={property.name}
              aria-label="Property name"
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name !== '' && name !== property.name) {
                  void run(() => api.dbUpdateProperty(databaseId, property.id, { name }));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
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
                    <input
                      defaultValue={option.name}
                      aria-label="Option name"
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (name !== '' && name !== option.name) {
                          void run(() =>
                            api.dbUpdateOption(databaseId, property.id, option.id, { name }),
                          );
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
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
                  <input
                    value={optionDrafts[property.id] ?? ''}
                    placeholder="New option"
                    aria-label={`New option for ${property.name}`}
                    onChange={(e) => {
                      setOptionDrafts({ ...optionDrafts, [property.id]: e.target.value });
                    }}
                    onKeyDown={(e) => {
                      const name = (optionDrafts[property.id] ?? '').trim();
                      if (e.key === 'Enter' && name !== '') {
                        void run(() => api.dbAddOption(databaseId, property.id, { name }));
                        setOptionDrafts({ ...optionDrafts, [property.id]: '' });
                      }
                    }}
                  />
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
    </section>
  );
}
