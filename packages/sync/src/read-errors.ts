/**
 * Telling a transient read failure apart from a permanent one.
 *
 * The storage port documents what `get` returning `undefined` means and says nothing
 * about it throwing — because until now nothing could. `MemoryStorage` never throws and
 * `FaultyStorage` models a half-written object as a byte PREFIX rather than an error, so
 * the one adapter that can fail, `NodeStorage`, has always thrown into callers that do
 * not expect it. One unreadable file therefore took down a whole sync cycle.
 *
 * On Windows this is not exotic. A OneDrive placeholder that cannot be recalled because
 * the machine is offline, a file the sync client is holding open, an antivirus scanner
 * mid-scan, and a handle limit under a large reconcile all surface here — and every one
 * of them is fixed by trying again in thirty seconds.
 *
 * The classification is deliberately a pure function over an error rather than a method
 * on the adapter. It is the only part that has to be exactly right, and this way it can
 * be tested against every errno without a filesystem that can produce them — the same
 * reasoning that made SettlePolicy.now injectable rather than ambient.
 */

/**
 * Codes that mean "not right now". Each is something a cloud-synced or virus-scanned
 * folder produces in normal operation.
 */
const TRANSIENT_CODES = new Set([
  /** The file is locked — a sync client or scanner has it open. */
  'EBUSY',
  /** Windows sharing violation, and what a cloud client's own cache lock looks like. */
  'EPERM',
  /** Permissions blip, or a placeholder the provider refused to recall. */
  'EACCES',
  /** The device or provider gave up mid-read. */
  'EIO',
  /** A recall that never completed. */
  'ETIMEDOUT',
  /** Too many open handles, which a large reconcile scan can reach on its own. */
  'EMFILE',
  'ENFILE',
  /** A network mount that went away and will come back. */
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  /** libuv's fallback when Windows returns a code it has no mapping for. Several of
   *  the ERROR_CLOUD_FILE_* family arrive this way, so it must be treated as retryable
   *  rather than as damage. */
  'UNKNOWN',
]);

/**
 * True when a failed read is worth retrying on a later cycle.
 *
 * ENOENT is deliberately absent: the port already turns absence into `undefined`, and a
 * missing object is a normal state during sync rather than a failure at all.
 *
 * The default for an unrecognised error is **false**. A caller treating something
 * permanent as transient retries it forever and never reports it, which is precisely the
 * silent-skip failure FORMAT.md section 3 forbids — so anything not known to be
 * temporary is surfaced.
 */
export function isTransientReadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}
