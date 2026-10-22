import { tr } from "../lib/i18n";
import { Marked, Renderer, type Tokens } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import powershell from "highlight.js/lib/languages/powershell";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import katex from "katex";
import "katex/dist/katex.min.css";
import { esc } from "./util";
import { iconHtml } from "./icons";

hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("dockerfile", dockerfile);

const hlCache = new Map<string, string>();
function highlight(code: string, lang: string) {
  const key = lang + "\u0000" + code;
  let out = hlCache.get(key);
  if (out) return out;
  try {
    // Unlabeled blocks are usually output or prose; auto-detection colours them at random.
    out = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : esc(code);
  } catch {
    out = esc(code);
  }
  if (hlCache.size > 400) hlCache.clear();
  hlCache.set(key, out);
  return out;
}

const mathCache = new Map<string, string>();
function tex(src: string, display: boolean) {
  const key = (display ? "D" : "I") + src;
  let out = mathCache.get(key);
  if (out) return out;
  try {
    out = katex.renderToString(src, { displayMode: display, throwOnError: false, output: "html", strict: "ignore" });
  } catch {
    out = `<code>${esc(src)}</code>`;
  }
  if (mathCache.size > 400) mathCache.clear();
  mathCache.set(key, out);
  return out;
}

const LANG_NAMES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", py: "Python", python: "Python",
  rs: "Rust", rust: "Rust", sh: "Shell", bash: "Bash", shell: "Shell", ps1: "PowerShell", powershell: "PowerShell",
  html: "HTML", css: "CSS", json: "JSON", sql: "SQL", go: "Go", java: "Java", c: "C", cpp: "C++", "c++": "C++",
  cs: "C#", csharp: "C#", yaml: "YAML", yml: "YAML", md: "Markdown", markdown: "Markdown", tsx: "TSX", jsx: "JSX",
  kotlin: "Kotlin", swift: "Swift", ruby: "Ruby", php: "PHP", lua: "Lua", xml: "XML", toml: "TOML",
  dockerfile: "Dockerfile", diff: "Diff",
};

// Chat models mean a single newline as a line break.
const md = new Marked({ gfm: true, breaks: true });

md.use({
  extensions: [
    {
      name: "blockMath",
      level: "block",
      start(src: string) {
        const m = src.match(/^ {0,3}(\$\$|\\\[)/m);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src) || /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/.exec(src);
        if (m) return { type: "blockMath", raw: m[0], text: m[1].trim() };
      },
      renderer(t) {
        return `<div class="katex-display">${tex(t.text, true)}</div>`;
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start(src: string) {
        const i = src.search(/\$|\\\(/);
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        let m = /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) return { type: "inlineMath", raw: m[0], text: m[1] };
        m = /^\$\$([^$\n]+?)\$\$/.exec(src);
        if (m) return { type: "inlineMath", raw: m[0], text: m[1], display: true };
        m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?![\d\w])/.exec(src);
        if (m) return { type: "inlineMath", raw: m[0], text: m[1] };
      },
      renderer(t) {
        return tex(t.text, !!t.display);
      },
    },
  ],
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const l = (lang || "").trim().split(/\s+/)[0].toLowerCase();
      const label = LANG_NAMES[l] || (l && l !== "text" && l !== "plaintext" ? l : tr("Texto"));
      const body = highlight(text.replace(/\n$/, ""), l);
      return (
        `<div class="code-block"><div class="code-head"><span>${esc(label)}</span>` +
        tr("<button type=\"button\" class=\"icon-btn\" data-copy-code>{0}<span>Copiar</span></button></div>", iconHtml("copy")) +
        `<pre><code class="hljs">${body}</code></pre></div>`
      );
    },
    table(token: Tokens.Table) {
      return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(src: string) {
  const html = md.parse(src || "") as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "data-copy-code"], FORBID_TAGS: ["style", "form"] });
}
