import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramGateway } from './index.js';

interface InternalGateway {
  handleUpdate(update: unknown): Promise<void>;
  dispatchUpdate(update: unknown): void;
}

function messageUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 42 },
      from: { id: 42, first_name: 'Operator' },
      text,
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TelegramGateway dispatch and activity', () => {
  const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) =>
    new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends typing immediately, refreshes it, and stops when handling completes', async () => {
    vi.useFakeTimers();
    const blocked = deferred();
    const gateway = new TelegramGateway('test-token', '42', 0);
    gateway.onMessage(async () => blocked.promise);

    const handling = (gateway as unknown as InternalGateway).handleUpdate(messageUpdate(1, 'Buffer parcels'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/sendChatAction');

    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    blocked.resolve();
    await handling;
    const callsAfterCompletion = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterCompletion);
  });

  it('keeps ordinary messages serial within a chat', async () => {
    const first = deferred();
    const seen: string[] = [];
    const gateway = new TelegramGateway('test-token', '42', 0);
    gateway.onMessage(async (message) => {
      seen.push(message.body);
      if (message.body === 'first') await first.promise;
    });
    const internal = gateway as unknown as InternalGateway;

    internal.dispatchUpdate(messageUpdate(1, 'first'));
    internal.dispatchUpdate(messageUpdate(2, 'second'));
    await vi.waitFor(() => expect(seen).toEqual(['first']));

    first.resolve();
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second']));
  });

  it('processes callbacks while a normal message is still running', async () => {
    const blocked = deferred();
    const gateway = new TelegramGateway('test-token', '42', 0);
    gateway.onMessage(async () => blocked.promise);
    const internal = gateway as unknown as InternalGateway;

    internal.dispatchUpdate(messageUpdate(1, 'long-running task'));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sendChatAction'))).toBe(true),
    );

    internal.dispatchUpdate({
      update_id: 2,
      callback_query: {
        id: 'callback-1',
        from: { id: 99, first_name: 'Unknown' },
        data: 'approve:request-1',
      },
    });

    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/answerCallbackQuery'))).toBe(
        true,
      ),
    );
    blocked.resolve();
  });
});
