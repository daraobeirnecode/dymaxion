// email gateway — stub. Sprint per Gateways Integration.md rollout.
// Implementing it means replacing StubGateway with a real adapter; the
// runtime wiring in main.ts stays unchanged.

import { StubGateway } from '../common.js';

export class EmailGateway extends StubGateway {
  constructor() {
    super('email');
  }
}
