// Run with: node scripts/test_i18n.cjs (after npm ci in web-app).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const app = path.join(__dirname, "../web-app");
const requireApp = createRequire(path.join(app, "package.json"));
const ts = requireApp("typescript");
const source = path.join(app, "src/lib/i18n.ts");
const code = ts.transpileModule(fs.readFileSync(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText;

function load(saved, unavailable = false) {
  const storage = new Map(saved ? [["ceu:language", saved]] : []);
  const document = { documentElement: { lang: "en" } };
  const exports = {};
  vm.runInNewContext(code, {
    exports, require: createRequire(source), document,
    localStorage: {
      getItem(key) { if (unavailable) throw Error("unavailable"); return storage.get(key) ?? null; },
      setItem(key, value) { if (unavailable) throw Error("unavailable"); storage.set(key, value); },
    },
  });
  return { ...exports, storage, document };
}

let count = 0;
for (const name of ["en.json", "metadata.en.json"]) {
  const catalog = JSON.parse(fs.readFileSync(path.join(app, "src/locales", name), "utf8"));
  for (const [key, translation] of Object.entries(catalog)) {
    assert(translation.trim(), `Empty translation: ${key}`);
    const params = (text) => [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
    assert.deepEqual(params(translation), params(key), `Interpolation mismatch: ${key}`);
    count++;
  }
}

for (const saved of [undefined, "auto", "en", "fr", "invalid"]) {
  const i18n = load(saved);
  assert.equal(i18n.getLanguage(), "en");
  assert.equal(i18n.tr("Configurações"), "Settings");
}

const i18n = load("pt-BR");
assert.equal(i18n.tr("Configurações"), "Configurações");
assert.equal(i18n.getLocale(), "pt-BR");
i18n.setLanguage("en");
assert.equal(i18n.document.documentElement.lang, "en");
assert.equal(i18n.storage.get("ceu:language"), "en");
assert.equal(i18n.getLocale(), "en-US");
assert.equal(i18n.tr("Remover {0}?", "Meu projeto {1}"), "Remove Meu projeto {1}?");
assert.equal(i18n.translateLabel("Revisão em cadeia"), "Chain review");
assert.equal(i18n.translateLabel("Falta Codex CLI — o CEU pode instalar"), "Missing Codex CLI — CEU can install it");
assert.equal(i18n.translateLabel("C:\\Projetos\\Minha pasta"), "C:\\Projetos\\Minha pasta");
assert.equal(i18n.translateLabel("Criar commit: Ajustar {0} no projeto"), "Create commit: Ajustar {0} no projeto");
assert.equal(i18n.translateLabel("Publicar branch atual em origin"), "Push current branch to origin");
assert.equal(i18n.translateLabel("Anexar C:\\Meu projeto\\arquivo.zip à release v1"), "Attach C:\\Meu projeto\\arquivo.zip to release v1");
i18n.setLanguage("pt-BR");
assert.equal(i18n.document.documentElement.lang, "pt-BR");
assert.equal(i18n.translateLabel("Revisão em cadeia"), "Revisão em cadeia");
assert.equal(load(i18n.storage.get("ceu:language")).getLanguage(), "pt-BR");
i18n.setLanguage("auto");
assert.equal(i18n.getLanguage(), "en");
const blocked = load(undefined, true);
blocked.setLanguage("pt-BR");
assert.equal(blocked.getLanguage(), "pt-BR");
console.log(`i18n OK: ${count} translations; defaults, switching, persistence, interpolation and unavailable storage.`);
