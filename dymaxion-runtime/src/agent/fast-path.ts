const GREETING_RE = /^(?:hi|hello|hey|hiya|yo|good\s+(?:morning|afternoon|evening))[!.\s]*$/i;
const PING_RE = /^\/?ping[!.\s]*$/i;

/**
 * Deterministic replies for messages that should never enter the LLM or
 * semantic-memory pipeline. Keep this deliberately narrow: ambiguous requests
 * still go through normal classification.
 */
export function deterministicReply(text: string): string | null {
  const normalized = text.trim();
  if (GREETING_RE.test(normalized)) {
    return 'Ready. Tell me the GIS problem, dataset, or system you want me to work on.';
  }
  if (PING_RE.test(normalized)) {
    return 'Dymaxion is online.';
  }
  return null;
}
