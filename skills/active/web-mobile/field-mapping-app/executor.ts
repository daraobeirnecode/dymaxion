#!/usr/bin/env tsx
/** field-mapping-app — Sprint 1 executor stub. */
async function main(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let params: Record<string, unknown>;
  try {
    params = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch (e) {
    console.log(JSON.stringify({ error: `invalid input JSON: ${e}` }));
    return 1;
  }
  const missing = ["project_name", "output_dir", "feature_schema", "sync_target"].filter(
    (k) => params[k] === undefined || params[k] === null || params[k] === ""
  );
  if (missing.length > 0) {
    console.log(JSON.stringify({ error: `missing required inputs: ${missing.join(", ")}` }));
    return 1;
  }
  const syncTarget = params.sync_target as Record<string, unknown>;
  if (typeof syncTarget.api_base_url === "string" && syncTarget.api_base_url.startsWith("postgres")) {
    console.log(
      JSON.stringify({
        error: "sync_target.api_base_url must be an HTTP API, not a direct database connection string",
      })
    );
    return 1;
  }
  console.error("TODO: implement field-mapping-app");
  console.log(
    JSON.stringify({
      project_path: `${params.output_dir}/${params.project_name}`,
      files_created: [],
      architecture_notes: "",
      sync_endpoint_spec: {},
      next_steps: [],
      status: "stub",
    })
  );
  return 0;
}
main().then((code) => process.exit(code));
