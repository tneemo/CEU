"""Git credential-helper entrypoint. Git passes the token only over helper stdout."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server.github import credential_helper  # noqa: E402


def main():
    try:
        request = sys.stdin.read(16_384)
        action = sys.argv[1] if len(sys.argv) > 1 else "get"
        if action == "get":
            sys.stdout.write(credential_helper(request))
            sys.stdout.flush()
    except Exception:
        # Never print diagnostic detail; this process may run in a Git operation.
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
