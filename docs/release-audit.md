# First public source release audit

Prepared locally on **2026-10-22**. No repository, tag or release was published.
The application version remains sourced from `web-app/src-tauri/tauri.conf.json`;
the existing RC version was not bumped during preparation.

This audit records the state before the subsequent English UI implementation.
For current language support, see [known limitations](limitations.md).

## Assessment before changes

The product brief describes a local workspace for conversations, tools and
coordination across model participants, with an expressive pt-BR interface.
The implementation already had substantial functionality: persistent streaming,
conversation trees, participant history projection, Rooms, Code approvals/undo,
persistent Agent tasks and a coordination review gate. Rebuilding those systems
would have expanded the release without solving the installation problems.

The review covered every top-level area: backend modules and API routes,
React state/components/styles, the legacy client and vendored assets, Rust/Tauri
startup and manifests, release/recovery/integration scripts and design notes.
The checkout initially contained no Python environment, npm dependencies or user
database, which exposed fresh-install failures directly.

Observed blockers:

- The recommended Python-only entry served an old client lacking Code/Agent.
- The built React client hard-coded the backend port even in a regular browser.
- Release recovery validation failed without a pre-existing user database.
- Dry-run required a new version and clean manifests, and omitted key tests.
- Backend recovery ran before port binding and could change active stream state
  during a failed second startup; different ports could share the same database.
- Static path containment used a string prefix, allowing sibling-directory paths;
  Host headers were accepted without a local-host check.
- A failed first dependency installation left a venv that the launcher would
  not repair. The browser could open even when backend startup failed.
- Release Tauri binaries tried to resolve the build machine's source directory
  and Python environment; startup errors were logged but not surfaced.
- License status was pending; bundled library license texts were missing.
- Two high-severity npm dependency findings existed (Vite and source-map-js).
- Settings exposed English, history retrieval and network blocking controls that
  did not implement those capabilities.
- Opening the empty first-run UI launched starter-card generation with no model
  selected, producing a background exception; it now uses static cards until setup.

## Changes and release boundary

The backend now serves the compiled React UI by default when present; the legacy
Chat fallback remains explicit and documented. Browser API requests use the
serving origin. A per-directory OS lock and bind-before-recovery order protect
startup state. Static paths use decoded, resolved path containment, and HTTP
requests validate local Host/Origin headers.

The Windows launcher retries dependency installation and checks CEU readiness.
Recovery tests use an isolated database even on a fresh checkout, and test
subprocesses override any inherited data-directory setting. The release dry-run
works without a version bump and runs all integration suites. The optional desktop
shell checks backend identity/readiness, propagates startup errors, and removes
the release dependency on a compile-time checkout path.

MIT was recommended before application and is now the license for CEU's original
code. Third-party license texts and notices are included separately. Public
documentation and `.gitignore` were updated, and compatible npm dependency fixes
were applied. A read-only GitHub Actions source-validation workflow is prepared;
it has not been run remotely.

The publication target is **source code with a browser UI**. Tauri still needs a
prepared checkout or a separately running Python backend. A compiled shell bundle
must not be advertised as a standalone CEU installer.

## Validation evidence

Environment: Windows, Python 3.14, Node 24.21, npm 11.19. Dependencies were installed
from `requirements.txt` and with `npm ci` before testing.

| Check | Result |
| --- | --- |
| Python dependency installation and `pip check` | Passed |
| Backend/scripts compilation | Passed |
| Startup/HTTP regression suite | 4 tests passed: duplicate instances, lock release/recovery, occupied-port behavior, frontend choice and static/Host/Origin boundaries |
| Calls, delegated Code/Agent and Rooms | Passed with local fake providers |
| Coordination, approvals, issues and independent review gate | Passed with local fake providers and temporary projects |
| Native Git/GitHub tools | Passed with temporary repositories and fake remote clients; no publication |
| Recovery `--real-db` on a fresh checkout | Passed using a new isolated database, including scheduled restart recovery |
| Recovery from an existing fixture database | Passed using a read-only SQLite backup of the isolated browser-test database, including restart after 60 seconds; no user database was used |
| Frontend lint | Exit 0; existing React hook/ref/purity and Fast Refresh warnings remain |
| TypeScript and production React build | Passed; large-bundle warning remains (approximately 948 kB JS before gzip) |
| `npm audit` after compatible updates | Zero reported vulnerabilities at preparation time |
| Browser, production build on an alternate port | First-run provider onboarding, simulated Chat send/stream/history/reload and Manual Code entry verified |
| Python 3.10 syntax parsing | Passed; execution here used Python 3.14; remote CI is prepared to test both |
| Full `release.py --dry-run` including Tauri/NSIS | Passed; compiled the Windows shell and generated its bundle; linker emitted an informational warning |
| Launch of compiled desktop executable | Not validated: automatic permission review blocked the local launch command with “blocked by policy”; no installer was run |
| Source ZIP install without `.git`, existing venv, npm dependencies or user database | Passed: new venv, pip install, `npm ci`, and full source dry-run; the final first-run fix also passed the extracted-source startup suite |

The source archive was tested separately after extraction. Its final snapshot
includes the same tested code and updated documentation. The generated NSIS bundle
remains a shell requiring the Python backend and is not part of the source
publication recommendation. Local validation logs and the source preview ZIP
are kept under the ignored `release-artifacts/` directory.

## Privacy and repository audit

- Scanned all 215 historical Git blobs for recognizable API keys, GitHub tokens,
  private-key headers, personal home paths and personal email domains: no matches.
- No tracked `.env`, user databases, local data, venv, npm dependencies, build
  products or logs were found. Existing commit authors use the project identity.
- The final 178-file publication set and source ZIP were checked again for secret
  patterns and private/build files, with no findings; ZIP integrity passed.
- The README screenshot was captured from a separate empty database, without
  accounts or personal content. Browser smoke tests used a separate fake provider.
- Provider keys remain plaintext in the local SQLite database. This is documented
  explicitly; hiding keys in API responses is not encryption.

Pattern scanning cannot prove the absence of all sensitive data. Review the final
staged files before publication; never include local data or build directories.

## Unverified and incomplete

No live paid-model request, vendor login, real GitHub push/release, OS credential
write, WSL2 provisioning, or long-running unattended workload was exercised.
macOS/Linux behavior is unverified. There is no English UI, automatic past-chat
retrieval, sandbox network blocking, backend authentication or encrypted database.
Code commands retain host-user access; undo cannot reverse arbitrary side effects.
External harness capabilities and permissions vary. See [limitations](limitations.md).

## Publication handoff

Ready locally: source installation path, README and screenshot, MIT license and
dependency notices, contribution/security guidance, integration checks and CI
definition. Preserve the experimental label when publishing.

Before an actual public release, review the final diff, commit the prepared
manifest changes, choose the repository destination, enable a private security
reporting channel if desired, and select a new RC version only when creating the
actual release. This preparation creates no commit, tag, push or remote release.
