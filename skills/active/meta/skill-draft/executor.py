#!/usr/bin/env python3
"""skill-draft — Sprint 1 executor stub."""
import json, sys

REQUIRED_INPUTS = ['failed_run_id', 'problem_description']


def main() -> int:
    raw = sys.stdin.read() or "{}"
    try:
        params = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid input JSON: {e}"}))
        return 1
    missing = [name for name in REQUIRED_INPUTS if name not in params]
    if missing:
        print(json.dumps({"error": f"missing required inputs: {', '.join(missing)}"}))
        return 1
    print("TODO: implement skill-draft", file=sys.stderr)
    print(json.dumps({'proposed_skill_id': '', 'skill_folder_path': '', 'status': 'stub'}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
