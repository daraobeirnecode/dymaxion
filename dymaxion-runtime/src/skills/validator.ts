// Pre-flight lint for PROPOSED (self-authored) skills. A draft that trips
// any of these patterns is rejected before it ever reaches the sandbox.
// This is a guardrail on generated code, not a general security scanner.

export interface LintFinding {
  pattern: string;
  line: number;
  excerpt: string;
}

const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'sql-drop', re: /\bDROP\s+(TABLE|SCHEMA|DATABASE|INDEX)\b/i },
  { name: 'sql-delete', re: /\bDELETE\s+FROM\b/i },
  { name: 'sql-truncate', re: /\bTRUNCATE\b/i },
  { name: 'rm-rf', re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i },
  { name: 'os-system', re: /\bos\.system\s*\(/ },
  { name: 'subprocess-call', re: /\bsubprocess\.(call|run|Popen|check_output)\s*\(/ },
  { name: 'eval-exec', re: /\b(eval|exec)\s*\(/ },
  { name: 'child-process', re: /\brequire\(['"]child_process['"]\)|from\s+['"]child_process['"]/ },
  { name: 'shutil-rmtree', re: /\bshutil\.rmtree\s*\(/ },
  { name: 'unlink', re: /\b(os\.remove|os\.unlink|fs\.(rm|rmSync|unlink|unlinkSync))\s*\(/ },
  { name: 'env-exfil', re: /\bprocess\.env\b.*\bfetch\(|os\.environ\b.*requests\./ },
];

// Calls a proposed executor IS allowed to make go through the runtime's own
// tool layer (MCP, worker client), never raw shell.
const ALLOWLIST_HINT =
  'Proposed skills must call tools via the runtime tool layer (MCP servers, worker client) — raw shell/subprocess/SQL-DDL is rejected.';

export function lintProposedExecutor(code: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      if (re.test(line)) {
        findings.push({ pattern: name, line: i + 1, excerpt: line.trim().slice(0, 120) });
      }
    }
  });
  return findings;
}

export function lintReport(findings: LintFinding[]): string {
  if (!findings.length) return 'pre-flight lint: clean';
  return [
    `pre-flight lint: REJECTED (${findings.length} finding${findings.length > 1 ? 's' : ''})`,
    ...findings.map((f) => `  line ${f.line} [${f.pattern}]: ${f.excerpt}`),
    ALLOWLIST_HINT,
  ].join('\n');
}
