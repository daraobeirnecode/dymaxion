'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Approve / Reject pair — POSTs { decision } to the given endpoint. */
export default function DecisionButtons({
  endpoint,
  approveValue = 'approved',
  rejectValue = 'rejected',
}: {
  endpoint: string;
  approveValue?: string;
  rejectValue?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
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
      <button className="btn-approve" disabled={busy} onClick={() => decide(approveValue)}>
        Approve
      </button>
      <button className="btn-reject" disabled={busy} onClick={() => decide(rejectValue)}>
        Reject
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
