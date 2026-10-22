# Architecture

CEU keeps the backend small: Python's `ThreadingHTTPServer`, JSON routes, SSE and
SQLite. There is no cloud control plane. Inference runs at the provider configured
by the user, which may be a local model server or a remote API.

```text
Browser (React production build / Vite development)
Optional Tauri shell                   Legacy web/ Chat client
                 \                     /
              HTTP JSON + Server-Sent Events
                         |
                    server/main.py
                         |
       generation.py ----+---- db.py -> SQLite + local files
          |              |
     providers.py        +-- calls.py / delegate.py / rooms.py
          |              +-- agent_mode.py / coordination.py
     model APIs          +-- code_tools.py / git_tools.py / github.py
                         +-- code_runtimes.py / integrations.py
                                      |
                         optional vendor SDKs and CLIs
```

- Conversations are message trees. Generations run in background threads and
  persist per-message events so SSE clients can reconnect and replay the stream.
- `calls.py` projects shared history for each participant, preserving authorship.
  `delegate.py` passes work into existing Code sessions or Agent tasks. `rooms.py`
  sequences participants; it does not implement a general workflow engine.
- CEU's Code loop scopes file tools to a selected folder. Commands run on the
  host. Optional Chat code execution uses a separate WSL2 distro and copies the
  conversation workspace in and out.
- Agent state, task schedules, parked approvals and progress are persisted.
  Coordination records issues and executors and checks an independent review
  against a content fingerprint before closing a changed objective.
- Provider keys live in SQLite. GitHub credentials use the OS secret store;
  vendor runtimes keep their own login state.
- `server/instance.py` locks each data directory before recovery. The backend
  binds its port before touching stored stream state, preventing failed starts
  from interrupting a running session.
- `web-app/src-tauri/tauri.conf.json` is the single source of version information;
  the release script synchronizes package manifests. Tauri is an optional shell,
  not a bundled Python distribution.

The [product brief (pt-BR)](../BRIEF.md) records the original direction. The
`referencias-*.md` documents are historical design references, not promises of
feature parity with external products. See [limitations](limitations.md) for
the public release's supported scope.
