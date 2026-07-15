// Formatting helpers — operator tone: concrete numbers, ISO-ish timestamps.

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function fmtCost(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '$0.0000';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (Number.isNaN(n)) return '$0.0000';
  return `$${n.toFixed(4)}`;
}

export function fmtDuration(start: Date | null, end: Date | null): string {
  if (!start || !end) return '—';
  const ms = end.getTime() - start.getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.slice(0, 8);
}

export function statusBadgeClass(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'succeeded':
    case 'success':
    case 'completed':
    case 'active':
    case 'approved':
    case 'ok':
      return 'badge-ok';
    case 'running':
    case 'pending':
    case 'proposed':
    case 'awaiting_approval':
      return 'badge-pending';
    case 'failed':
    case 'error':
    case 'rejected':
    case 'frozen':
      return 'badge-failed';
    default:
      return 'badge-neutral';
  }
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
