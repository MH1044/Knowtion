/**
 * @knowtion/sync — storage port, transport adapters, and the deterministic simulator.
 *
 * The storage port is deliberately five primitives and no more. It is NOT a
 * filesystem abstraction: a POSIX-shaped interface hides exactly the provider
 * differences that decide correctness (Google Drive has no compare-and-swap and
 * permits duplicate filenames in a folder).
 */

export const SYNC_VERSION = '0.0.0' as const;
