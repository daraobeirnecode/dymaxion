const DISABLED_PHASE0_ROUTES = new Set([
  'POST /arcpy/run',
  'POST /pro-cli/run',
  'POST /files/upload',
  'GET /files/download',
]);

export const PHASE0_DISABLED_MESSAGE =
  'Windows execution and file shuttling are disabled in Phase 0 pending an allowlisted job catalog and independent security testing.';

export function phase0RouteDisabled(route: string): boolean {
  return DISABLED_PHASE0_ROUTES.has(route);
}
