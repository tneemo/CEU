# Contributing to CEU

CEU is an experimental local application. Small fixes, reproducible bug reports,
and clearer documentation are especially useful for the first public release.
Discuss larger changes before introducing new dependencies or architecture.

The GitHub Actions workflow validates the source release on Windows with Python
3.10 and 3.14 and Node 24. It has read-only repository permissions and does not
publish packages, tags or releases. Remote CI results are available only after
the repository is published and the workflow runs.

## Development

Follow the [README](README.md) to install Python and frontend dependencies.
Run the backend in one terminal and `npm run dev` in `web-app/` in another.
The UI is in Brazilian Portuguese; keep new UI messages in pt-BR. The public
README and contributor guides use English. Existing design notes in `docs/`
describe both implemented and proposed behavior in Portuguese.

For a source release, run this from the repository root:

```powershell
.\.venv\Scripts\python.exe scripts/release.py --dry-run --skip-tauri
```

On macOS/Linux use `.venv/bin/python` instead. This runs backend compilation,
startup/security regressions, calls/Rooms, coordination, Git tools, recovery,
frontend lint and the production build. Tests use temporary databases and fake
model responses; no paid API key or GitHub account is required. With `--real-db`,
the recovery test reads an existing database only to make an isolated SQLite
backup, or uses a fresh database if none exists.

To check the optional desktop bundle, omit `--skip-tauri` after installing the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
Separate development instances need both a different `CEU_DATA_DIR` and port.

## Pull requests

- Explain the observed problem, resulting behavior, and validation performed.
- Keep changes focused; preserve the existing approval and recovery behavior.
- Update documentation when installation, configuration, or limitations change.
- Do not commit `.env`, `data/`, logs, credentials, local paths, or build outputs.
- Use `CEU_*` for public configuration. The version belongs in
  `web-app/src-tauri/tauri.conf.json`; release tooling synchronizes other manifests.
- Contributions are provided under the [MIT license](LICENSE). Retain upstream
  notices for third-party code; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Local release workflow

`--dry-run` validates without changing versions or creating commits or tags.
`--skip-tauri` validates the source/web release only.

An actual `--version X.Y.Z-rc.N` run updates manifests, builds, stages changes,
and creates a local commit and tag. It requires relevant code changes since the
last tag and refuses edited version manifests. Review and commit prepared
manifest changes before that step. It never pushes or creates a GitHub release.
Do not run the actual release command just to test a checkout.
