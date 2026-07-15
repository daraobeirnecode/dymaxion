'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Generic action button — POSTs an empty JSON body to the endpoint, then refreshes. */
export default function PostButton({
  endpoint,
  label,
  variant = 'default',
  confirmText,
}: {
  endpoint: string;
  label: string;
  variant?: 'default' | 'danger';
  confirmText?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button className={variant === 'danger' ? 'btn-reject' : 'btn'} disabled={busy} onClick={run}>
        {label}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
