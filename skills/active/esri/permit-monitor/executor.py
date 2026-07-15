#!/usr/bin/env python3
"""permit-monitor — Sprint 1 executor stub."""
import json, sys

REQUIRED_INPUTS = ["service_url", "filter_where"]


def main() -> int:
    raw = sys.stdin.read() or "{}"
    try:
        params = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid input JSON: {e}"}))
        return 1
    missing = [name for name in REQUIRED_INPUTS if name not in params or params[name] in (None, "")]
    if missing:
        print(json.dumps({"error": f"missing required input(s): {', '.join(missing)}"}))
        return 1
    print("TODO: implement permit-monitor", file=sys.stderr)
    print(json.dumps({"new_permits": [], "alert_message": "", "status": "stub"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
