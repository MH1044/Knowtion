/**
 * @knowtion/format — the on-disk and on-cloud format.
 *
 * NOTHING IN THIS PACKAGE IS FROZEN YET. The format freeze (see the roadmap) must
 * complete before any byte of real user data is written, because Knowtion has no
 * backend and therefore can never run a migration on a user's behalf.
 */

/** Magic bytes at the head of every Knowtion pack file. */
export const PACK_MAGIC = 'KNOW' as const;

/**
 * Envelope format version. Incremented only for changes to the pack header layout.
 *
 * Compatibility rule: a reader seeing a MAJOR version above its own must refuse to
 * write and may offer read-only access. It must never silently drop fields it does
 * not understand.
 */
export const ENVELOPE_VERSION = 0 as const;

/** Placeholder until the format freeze lands. */
export const FORMAT_FROZEN = false as const;
