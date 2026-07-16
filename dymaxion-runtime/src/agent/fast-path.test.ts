import { describe, expect, it } from 'vitest';
import { deterministicReply } from './fast-path.js';

describe('deterministicReply', () => {
  it.each(['Hi', 'hello!', 'Hey', 'good morning'])('handles greeting %s without an LLM', (text) => {
    expect(deterministicReply(text)).toBe(
      'Ready. Tell me the GIS problem, dataset, or system you want me to work on.',
    );
  });

  it('handles health pings deterministically', () => {
    expect(deterministicReply('/ping')).toBe('Dymaxion is online.');
  });

  it('does not swallow actionable requests', () => {
    expect(deterministicReply('Hey, buffer these parcels by 100 feet')).toBeNull();
  });
});
