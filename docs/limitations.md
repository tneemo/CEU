# Release scope and known limitations

The first public release is an experimental **source release**, tested on Windows.
There is no stability, compatibility, or unattended-operation guarantee yet.

| Area | Present behavior and limits |
| --- | --- |
| Chat | Streaming, history branches, attachments, search, export and manual memory exist. Provider/model capabilities vary; an OpenAI-compatible endpoint is not a guarantee of complete API compatibility. |
| Model calls and Rooms | Implemented and covered by simulated-provider integration tests. Rooms follow a fixed order, without voting, judging or conditional branching. |
| Code | CEU's own loop provides approvals, file tools, shell commands, steering and tracked edit undo. Shell side effects cannot be reliably undone; commands have the host user's access. |
| Agent and coordination | Experimental persistent tasks, schedules, notes, delegated executors and independent review gate. Tasks run only while the backend is open. Review is a protocol check, not proof of correctness or security. |
| External runtimes | Optional Codex, Claude SDK/CLI and REDIR integrations depend on separately installed tools, vendor accounts and changing protocols. They were not validated against live accounts for this release. REDIR lacks CEU approval cards, undo and steering; SDK support differs. |
| Git/GitHub | Native tools and permission checks are tested with temporary repositories and fake remote clients. No real account, push, release or credential-store interaction was exercised in preparation. |
| WSL2 execution | Windows-only optional Chat execution; first use downloads Ubuntu and packages. Always has network access. Provisioning was not exercised in release validation. |
| Language | UI is pt-BR. English UI and automatic language detection are not implemented; the selector is disabled. |
| Memory | User-authored memories are included in prompts when enabled. Automatic retrieval of past chats is not implemented; its switch is disabled. Starter suggestions may use recent history separately. |
| Storage | SQLite and files are local, including provider keys stored in plaintext. GitHub uses the OS credential store; external tools have separate stores. No encrypted database or multi-user authentication. |
| Browser UI | Production React build is served by Python on the same origin. Without a build, Python falls back to the older Chat-only `web/` UI; it lacks Code, Agent and the new coordination controls. |
| Desktop | Optional Tauri shell requires a prepared checkout or separately running backend on port 4747. It does not include Python or the backend. A self-contained installer is not ready. |
| Platforms | Windows is the validation platform. Portable Python/browser commands are documented, but macOS/Linux execution and desktop bundles have not been validated. |
| Quality checks | Integration tests use fake models. They cannot establish current provider compatibility, model quality, paid API behavior, or real-world long-running reliability. Lint/build warnings remain documented in the release audit. |

See [SECURITY.md](../SECURITY.md), [runtime details (pt-BR)](runtimes-code.md),
and [coordination design (pt-BR)](coordenacao.md) before enabling automation.
