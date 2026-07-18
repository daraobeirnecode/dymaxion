import { createHash } from 'node:crypto';

/** Convert JSON-compatible data to an RFC 8785-style stable representation. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires a finite JSON number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON accepts only plain objects');
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => {
        if (item === undefined) throw new TypeError(`canonical JSON does not allow undefined at '${key}'`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON does not allow ${typeof value}`);
}

export function sha256Text(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}
