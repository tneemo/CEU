# CEU desktop frontend

Este diretório contém o frontend React/TypeScript/Vite e a casca Tauri do CEU — Composable Experimentation Unit.

```powershell
npm ci
npm run dev
npm run lint
npm run build
npx tauri dev
npx tauri build
```

O backend deve estar rodando em `http://127.0.0.1:4747`. Para usar outra porta durante o desenvolvimento, defina `CEU_API_PORT` antes de `npm run dev`.
