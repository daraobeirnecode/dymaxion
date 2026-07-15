#!/usr/bin/env python3
"""martin-tile-serve — Sprint 1 executor stub."""
import json, sys

REQUIRED = ['table', 'connection']


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
    print("TODO: implement martin-tile-serve", file=sys.stderr)
    print(json.dumps({"tile_endpoint": "", "config_path": params.get("config_path", ""), "status": "stub"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
