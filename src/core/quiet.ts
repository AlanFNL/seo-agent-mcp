/**
 * Suppress Node's `ExperimentalWarning` for `node:sqlite`.
 *
 * The built-in SQLite module is still flagged experimental, so Node prints a
 * two-line warning on every single invocation. Using it is a deliberate choice
 * — it's what lets this package install with zero native dependencies — and the
 * warning is noise the user can't act on. Every *other* warning still prints.
 *
 * This runs as an import side effect rather than an exported function, and the
 * entry points import it *first*. ESM hoists and evaluates all imports before
 * any statement in the module body, so a `suppress()` call in the body would
 * run after `node:sqlite` had already loaded and warned. Being a side effect of
 * the first import is what makes the ordering work.
 */
const original = process.emitWarning.bind(process);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
  const text = typeof warning === 'string' ? warning : warning.message;
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (original as any)(warning, ...rest);
};

export {};
