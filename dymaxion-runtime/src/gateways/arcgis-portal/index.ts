// arcgis-portal gateway — stub. Sprint per Gateways Integration.md rollout.
// Implementing it means replacing StubGateway with a real adapter; the
// runtime wiring in main.ts stays unchanged.

import { StubGateway } from '../common.js';

export class ArcgisPortalGateway extends StubGateway {
  constructor() {
    super('arcgis-portal');
  }
}
