/** Compatibility boundary for DSH's legacy headers and handle-based persistence. */
import { dirname, isAbsolute } from 'node:path';

interface PersistenceView {
  // JSONL still exposes this diagnostic hook after its removal from the base
  // service. Other backends may omit it; never invent a disk location for them.
  locate?: (header: unknown) => { path: string } | undefined;
  stat?: (id: string, options: { signal: AbortSignal }) => Promise<{ header: unknown } | undefined>;
  list: (signal: AbortSignal) => Promise<readonly unknown[]>;
}

export function sessionArtifactDirectory(persistence: unknown, header: unknown): string | undefined {
  const backend = persistence as PersistenceView;
  const location = backend.locate?.(header);
  return location !== undefined && isAbsolute(location.path) ? dirname(location.path) : undefined;
}

/** Resolve through the backend, including after a restart when no Agent is loaded. */
export async function persistedSessionArtifactDirectory(
  persistence: unknown,
  sessionId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const backend = persistence as PersistenceView;
  let header: unknown;
  if (typeof backend.stat === 'function') {
    header = (await backend.stat(sessionId, { signal }))?.header;
  } else {
    const entries = await backend.list(signal);
    header = entries.map((entry) => {
      if (entry !== null && typeof entry === 'object' && 'header' in entry) return entry.header;
      return entry;
    }).find((entry) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === sessionId);
  }
  signal.throwIfAborted();
  return header === undefined ? undefined : sessionArtifactDirectory(backend, header);
}
