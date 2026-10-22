# CEU frontend and desktop shell

React, TypeScript and Vite provide the full UI. Python serves `dist/` after a
production build, so Tauri is optional. See the [root README](../README.md)
for complete setup and provider configuration.

```powershell
npm ci
npm run dev
npm run lint
npm run build
```

For development, run the backend separately. Vite listens on
`http://localhost:5173` and proxies `/api` to `http://127.0.0.1:4747`.
Set `CEU_API_PORT` for a different backend port before `npm run dev`.
`npm run preview` is a static build preview, not a complete CEU server.

## Optional desktop shell

On Windows, install Rust 1.90+, MSVC Build Tools and WebView2, as described in the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```powershell
npx tauri dev
```

The shell uses port **4747**. It reuses a healthy CEU server or starts the checkout's
`.venv` Python, waits for readiness, and stops only the process it started.
For another checkout, set `CEU_ROOT` to its absolute path.

`npx tauri build` produces a shell bundle, **not a self-contained CEU installer**.
Python, the backend and its dependencies are not bundled. A release shell needs
a running backend or `CEU_ROOT` pointing to a prepared checkout. It never uses the
build machine's source path. Standalone installers and macOS/Linux desktop
distribution are outside the first public source release.
