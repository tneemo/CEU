import { apiUrl } from "../api";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const isMobile = () => matchMedia("(max-width: 760px)").matches;
/** Configurações → Aparência → Movimento: "reduce" and "full" override the OS preference. */
export const reducedMotion = () => {
  const m = document.documentElement.dataset.motion;
  return m === "reduce" || (m !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
};
export const isTauri = () => "__TAURI_INTERNALS__" in window;

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout>;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function extOf(name: string) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || "");
  return m ? m[1] : "txt";
}

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
export function relTime(ts: number) {
  const s = Date.now() / 1000 - ts;
  if (s < 45) return "agora";
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), "day");
  return new Date(ts * 1000).toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
}

export function dateGroup(ts: number) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return "Hoje";
  if (t >= start - 86400000) return "Ontem";
  if (t >= start - 6 * 86400000) return "Últimos 7 dias";
  if (t >= start - 29 * 86400000) return "Últimos 30 dias";
  const label = d.toLocaleDateString("pt-BR", { month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    Object.assign(ta.style, { position: "fixed", opacity: "0" });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem("ceu:" + k);
      return v == null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem("ceu:" + k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem("ceu:" + k);
    } catch {
      /* storage unavailable */
    }
  },
  raw(k: string, v: string) {
    try {
      localStorage.setItem("ceu:" + k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

export function kbd(combo: string) {
  return combo.replace(/Ctrl/g, isMac ? "⌘" : "Ctrl");
}

export function autosize(ta: HTMLTextAreaElement, max?: number) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, max ?? Infinity) + "px";
}

/** Open a link outside the app: the system browser under Tauri, a new tab otherwise. */
export async function openExternal(url: string) {
  if (isTauri()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_blank", "noopener");
}

/** Download a server file. Fetch + blob works the same in the browser and in the Tauri webview. */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(apiUrl(path));
  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
