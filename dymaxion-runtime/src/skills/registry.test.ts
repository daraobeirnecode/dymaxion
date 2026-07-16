import { describe, expect, it } from 'vitest';
import { isStubExecutor } from './registry.js';

describe('isStubExecutor', () => {
  it('detects TODO executors', () => {
    expect(isStubExecutor('# TODO: implement with ArcPy')).toBe(true);
  });

  it('detects executors that report stub success', () => {
    expect(isStubExecutor('print(json.dumps({"status": "stub"}))')).toBe(true);
  });

  it('keeps implemented executors available', () => {
    expect(isStubExecutor('print(json.dumps({"status": "ok", "count": 47}))')).toBe(false);
  });
});
