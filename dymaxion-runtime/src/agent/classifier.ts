// Intent classification — cheapest/fastest tier (classification →
// claude-haiku-4-5 by default). Determines domain + complexity so the
// planner loads only applicable skills.

import { callLLM } from '../llm/middleware.js';
import type { Complexity, IncomingMessage } from '../gateways/common.js';

export interface Intent {
  domain: 'esri' | 'oss' | 'web-mobile' | 'architecture' | 'meta' | 'general';
  complexity: Complexity;
  isQuestion: boolean;
  summary: string;
}

const SYSTEM = `Classify the incoming GIS request. Respond with ONLY minified JSON:
{"domain":"esri|oss|web-mobile|architecture|meta|general","complexity":"trivial|simple|complex","isQuestion":true|false,"summary":"<10 words>"}
domain: esri = ArcGIS/arcpy/Esri platform; oss = QGIS/PostGIS/GDAL/tiles/STAC/OSM; web-mobile = map app development; architecture = design decisions; meta = skill management; general = anything else.
complexity: trivial = single lookup/answer; simple = one skill; complex = multi-step plan.`;

export async function classify(msg: IncomingMessage, agentRunId?: string): Promise<Intent> {
  const fallback: Intent = {
    domain: 'general',
    complexity: 'simple',
    isQuestion: false,
    summary: msg.body.slice(0, 60),
  };
  try {
    const res = await callLLM({
      skillSlug: 'intent-classifier',
      skillClass: 'classification',
      system: SYSTEM,
      prompt: msg.body.slice(0, 4000),
      maxTokens: 200,
      temperature: 0,
      agentRunId,
      purpose: 'classify',
    });
    const jsonMatch = res.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as Partial<Intent>;
    return {
      domain: (parsed.domain as Intent['domain']) ?? 'general',
      complexity: (parsed.complexity as Complexity) ?? 'simple',
      isQuestion: Boolean(parsed.isQuestion),
      summary: parsed.summary ?? fallback.summary,
    };
  } catch {
    return fallback;
  }
}
