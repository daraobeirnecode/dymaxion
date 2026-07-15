#!/usr/bin/env python3
"""qgis-project-editor — Sprint 1 executor stub."""
import json, sys

REQUIRED = ['project_path', 'edits']


def main() -> int:
    raw = sys.stdin.read() or "{}"
    try:
        params = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid input JSON: {e}"}))
        return 1
    missing = [k for k in REQUIRED if k not in params or params[k] in (None, "")]
    if missing:
        print(json.dumps({"error": f"missing required inputs: {', '.join(missing)}"}))
        return 1
    print("TODO: implement qgis-project-editor", file=sys.stderr)
    print(json.dumps({"project_path": params.get("project_path", ""), "applied_edits": [], "backup_path": "", "status": "stub"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
