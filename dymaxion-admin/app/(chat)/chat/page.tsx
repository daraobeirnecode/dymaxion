'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseApprovalReview,
  parseArtifactAttachments,
  type ApprovalReview,
  type ArtifactAttachment,
} from './chat-contract';

type EventKind = 'user' | 'plan' | 'progress' | 'approval_required' | 'final' | 'error';

interface ChatEvent {
  id: number;
  kind: EventKind;
  text: string;
  data?: unknown;
  attachments?: ArtifactAttachment[];
  approvalId?: string;
  approval?: ApprovalReview;
  decided?: string;
}

function getSessionId(): string {
  if (typeof window === 'undefined') return '';
  let id = window.localStorage.getItem('dymaxion-chat-session');
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem('dymaxion-chat-session', id);
  }
  return id;
}

let nextEventId = 1;

/** Parse SSE frames out of a text buffer; returns [events, remainder]. */
function parseSse(buffer: string): [{ event: string; data: string }[], string] {
  const frames: { event: string; data: string }[] = [];
  const parts = buffer.split('\n\n');
  const remainder = parts.pop() ?? '';
  for (const part of parts) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) frames.push({ event, data: dataLines.join('\n') });
  }
  return [frames, remainder];
}

export default function ChatPage() {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSessionId(getSessionId());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const push = useCallback((e: Omit<ChatEvent, 'id'>) => {
    setEvents((prev) => [...prev, { ...e, id: nextEventId++ }]);
  }, []);

  const handleFrame = useCallback(
    async (event: string, dataRaw: string): Promise<void> => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(dataRaw) as Record<string, unknown>;
      } catch {
        data = { text: dataRaw };
      }
      const type = event !== 'message' ? event : String(data.type ?? 'progress');
      const text = String(data.text ?? data.message ?? data.narrative ?? data.description ?? '');

      switch (type) {
        case 'plan':
          push({ kind: 'plan', text, data: data.plan ?? data });
          break;
        case 'approval_required': {
          const approval = await parseApprovalReview(data);
          push({
            kind: 'approval_required',
            text: text || 'Approval required',
            approval: approval ?? undefined,
            approvalId: approval?.approval_id,
          });
          break;
        }
        case 'final':
          push({
            kind: 'final',
            text: text || dataRaw,
            data: data.cost_usd,
            attachments: parseArtifactAttachments(data.attachments),
          });
          break;
        case 'error':
          push({ kind: 'error', text: text || dataRaw });
          break;
        default:
          push({ kind: 'progress', text: text || dataRaw });
      }
    },
    [push]
  );

  async function send() {
    const body = input.trim();
    if (!body || busy) return;
    setInput('');
    push({ kind: 'user', text: body });
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: body, session_id: sessionId, gateway: 'admin-dashboard' }),
      });
      if (!res.ok || !res.body) {
        push({ kind: 'error', text: `Runtime returned HTTP ${res.status}` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const [frames, remainder] = parseSse(buffer);
        buffer = remainder;
        for (const f of frames) await handleFrame(f.event, f.data);
      }
      if (buffer.trim()) {
        const [frames] = parseSse(buffer + '\n\n');
        for (const f of frames) await handleFrame(f.event, f.data);
      }
    } catch (e) {
      push({
        kind: 'error',
        text: `Stream failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function decide(eventId: number, approvalId: string, decision: string) {
    try {
      const res = await fetch(`/api/approvals/${approvalId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEvents((prev) =>
        prev.map((e) => (e.id === eventId ? { ...e, decided: decision } : e))
      );
    } catch (e) {
      push({
        kind: 'error',
        text: `Approval update failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] max-w-4xl flex-col">
      <div className="mb-3 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-neutral-100">Chat</h1>
        <span className="font-mono text-xs text-neutral-600">
          session {sessionId ? sessionId.slice(0, 8) : '…'}
        </span>
      </div>

      <div className="card flex-1 space-y-3 overflow-y-auto">
        {events.length === 0 && (
          <p className="text-sm text-neutral-500">
            Message the agent. Plan, progress, approval requests, and the final narrative stream in
            below.
          </p>
        )}
        {events.map((e) => {
          switch (e.kind) {
            case 'user':
              return (
                <div key={e.id} className="rounded border border-surface-border bg-surface p-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-neutral-600">
                    operator
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-neutral-200">{e.text}</p>
                </div>
              );
            case 'plan':
              return (
                <div key={e.id} className="rounded border border-sky-900 bg-sky-950/30 p-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-sky-500">plan</div>
                  {e.text && <p className="mb-1 text-sm text-neutral-300">{e.text}</p>}
                  {e.data != null && (
                    <pre className="code-block">{JSON.stringify(e.data, null, 2)}</pre>
                  )}
                </div>
              );
            case 'progress':
              return (
                <div key={e.id} className="px-3 text-sm text-neutral-400">
                  <span className="mr-2 text-xs uppercase tracking-wide text-neutral-600">
                    progress
                  </span>
                  {e.text}
                </div>
              );
            case 'approval_required':
              return (
                <div key={e.id} className="rounded border border-amber-900 bg-amber-950/30 p-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-amber-500">
                    approval required
                  </div>
                  <p className="mb-2 text-sm text-neutral-200">{e.text}</p>
                  {e.approval ? (
                    <div className="mb-3 space-y-2 text-xs text-neutral-300">
                      <p>
                        <span className="text-neutral-500">Description (untrusted summary): </span>
                        {e.approval.description_untrusted}
                      </p>
                      <dl className="grid gap-1 sm:grid-cols-[9rem_1fr]">
                        <dt className="text-neutral-500">Exact target</dt>
                        <dd className="break-all font-mono">{e.approval.target}</dd>
                        <dt className="text-neutral-500">Credential identity</dt>
                        <dd className="break-all font-mono">{e.approval.credential_identity}</dd>
                        <dt className="text-neutral-500">Expires</dt>
                        <dd className="font-mono">{e.approval.expires_at}</dd>
                        <dt className="text-neutral-500">Payload SHA-256</dt>
                        <dd className="break-all font-mono">{e.approval.payload_sha256}</dd>
                      </dl>
                      <div>
                        <div className="mb-1 text-neutral-500">Step payload</div>
                        <pre className="code-block">
                          {JSON.stringify(e.approval.payload, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-1 text-neutral-500">Canonical approval payload</div>
                        <pre className="code-block whitespace-pre-wrap break-all">
                          {e.approval.canonical_payload}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <p className="mb-2 text-xs text-red-300">
                      Incomplete approval facts. Decision controls are disabled.
                    </p>
                  )}
                  {e.decided ? (
                    <span
                      className={e.decided === 'approved' ? 'badge-ok' : 'badge-failed'}
                    >
                      {e.decided}
                    </span>
                  ) : e.approvalId ? (
                    <span className="inline-flex gap-2">
                      <button
                        className="btn-approve"
                        onClick={() => decide(e.id, e.approvalId!, 'approved')}
                      >
                        Approve
                      </button>
                      <button
                        className="btn-reject"
                        onClick={() => decide(e.id, e.approvalId!, 'rejected')}
                      >
                        Reject
                      </button>
                    </span>
                  ) : (
                    <span className="text-xs text-neutral-500">
                      No approval id in event — decide on the Approvals page.
                    </span>
                  )}
                </div>
              );
            case 'final':
              return (
                <div key={e.id} className="rounded border border-green-900 bg-green-950/20 p-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-green-500">final</div>
                  <p className="whitespace-pre-wrap text-sm text-neutral-200">{e.text}</p>
                  {e.attachments && e.attachments.length > 0 && (
                    <div className="mt-3 grid gap-2">
                      {e.attachments.map((attachment) => (
                        <a
                          key={`${attachment.handle}:${attachment.sha256}`}
                          href={attachment.download_url}
                          className="flex items-center justify-between rounded border border-green-900/70 bg-black/20 px-3 py-2 text-sm text-green-300 hover:border-green-700 hover:text-green-200"
                        >
                          <span className="font-medium">{attachment.original_name}</span>
                          <span className="font-mono text-xs text-neutral-500" title={attachment.sha256}>
                            {attachment.bytes.toLocaleString()} bytes · {attachment.sha256.slice(0, 12)}…
                          </span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            case 'error':
              return (
                <div key={e.id} className="rounded border border-red-900 bg-red-950/30 p-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-red-500">error</div>
                  <p className="text-sm text-red-300">{e.text}</p>
                </div>
              );
          }
        })}
        <div ref={bottomRef} />
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          void send();
        }}
      >
        <input
          className="input flex-1"
          value={input}
          onChange={(ev) => setInput(ev.target.value)}
          placeholder={busy ? 'Agent is working…' : 'Instruct the agent'}
          disabled={busy}
        />
        <button type="submit" className="btn" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
