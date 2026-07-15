#!/usr/bin/env tsx
/** nextjs-map-app-scaffold — Sprint 1 executor stub. */
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
  const missing = ["project_name", "output_dir", "map_library"].filter(
    (k) => params[k] === undefined || params[k] === null || params[k] === ""
  );
  if (missing.length > 0) {
    console.log(JSON.stringify({ error: `missing required inputs: ${missing.join(", ")}` }));
    return 1;
  }
  const validLibraries = ["arcgis", "maplibre", "deckgl"];
  if (!validLibraries.includes(String(params.map_library))) {
    console.log(
      JSON.stringify({ error: `map_library must be one of: ${validLibraries.join(", ")}` })
    );
    return 1;
  }
  console.error("TODO: implement nextjs-map-app-scaffold");
  console.log(
    JSON.stringify({
      project_path: `${params.output_dir}/${params.project_name}`,
      files_created: [],
      dev_command: "npm run dev",
      next_steps: [],
      status: "stub",
    })
  );
  return 0;
}
main().then((code) => process.exit(code));
