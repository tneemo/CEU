// Search + command palette (port of web/js/palette.js).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type SearchResult } from "../api";
import { Ic } from "../lib/icons";
import { kbd, relTime } from "../lib/util";
import { exportConversation, goArea, newChat, newCodeSession, openConversation, setArchived, setTemporary, toggleSidebar, toggleTheme, view } from "../state/actions";
import { useApp } from "../state/store";
import { closeDialog, openSettings } from "../state/ui";
import { DialogShell, listNav } from "./Overlay";

const norm = (s: string) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// 3: whole text starts with query · 2: a word starts with it · 1: substring · 0: no match
const score = (text: string, nq: string) => {
  const n = norm(text);
  if (!nq) return 1;
  if (n.startsWith(nq)) return 3;
  if (n.split(/[^a-z0-9]+/).some((w) => w.startsWith(nq))) return 2;
  return n.includes(nq) ? 1 : 0;
};

function Mark({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = norm(text).indexOf(norm(q));
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

interface Row {
  key: string;
  icon: string;
  title: ReactNode;
  snippet?: ReactNode;
  when?: string;
  k?: string;
  run: () => void;
}

export function Palette({ id }: { id: number }) {
  const convs = useApp((s) => s.convs);
  const current = useApp((s) => s.current);
  const [q, setQ] = useState("");
  const [server, setServer] = useState<{ q: string; results: SearchResult[] }>({ q: "", results: [] });
  const listRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<ReturnType<typeof listNav> | null>(null);
  const tq = q.trim();

  useEffect(() => {
    const nav = listNav(listRef.current!);
    navRef.current = nav;
    return () => nav.destroy();
  }, []);

  useEffect(() => {
    if (!tq) return;
    const t = setTimeout(async () => {
      try {
        const results = await api.search(tq);
        setServer({ q: tq, results });
      } catch {
        /* offline: local results only */
      }
    }, 140);
    return () => clearTimeout(t);
  }, [tq]);

  const close = () => closeDialog(id);

  const sections = useMemo(() => {
    const nq = norm(tq);
    const dark = document.documentElement.dataset.theme === "dark";
    const actions = [
      { label: "Nova conversa", icon: "new", run: () => newChat({ code: false }) },
      { label: "Nova sessão de código", icon: "code", run: () => newCodeSession() },
      { label: "Ir para Chat", icon: "chat", kbd: "Ctrl ⇧ 1", run: () => goArea("chat") },
      { label: "Ir para Code", icon: "code", kbd: "Ctrl ⇧ 2", run: () => goArea("code") },
      { label: "Trocar modelo", icon: "cube", kbd: "Ctrl .", run: () => setTimeout(() => view.openModelPicker(), 0) },
      { label: dark ? "Usar tema claro" : "Usar tema escuro", icon: dark ? "sun" : "moon", run: () => toggleTheme() },
      { label: "Alternar barra lateral", icon: "sidebar", kbd: "Ctrl B", run: () => toggleSidebar() },
      { label: "Configurações", icon: "settings", kbd: "Ctrl ,", run: () => openSettings("general") },
      { label: "Provedores e modelos", icon: "plug", run: () => openSettings("providers") },
      { label: "Personalização e instruções", icon: "user", run: () => openSettings("personalization") },
      { label: "Atalhos de teclado", icon: "keyboard", kbd: "Ctrl /", run: () => openSettings("shortcuts") },
      { label: "Nova conversa temporária", icon: "ghost", run: () => setTemporary(true) },
      { label: "Aparência", icon: "palette", run: () => openSettings("appearance") },
      { label: "Memória", icon: "memory", run: () => openSettings("memory") },
      { label: "Uso e estatísticas", icon: "gauge", run: () => openSettings("usage") },
      { label: "Conversas arquivadas e exportação", icon: "archive", run: () => openSettings("data") },
      ...(current ? [{ label: "Exportar conversa como Markdown", icon: "download", run: () => exportConversation(current.conv) }] : []),
      ...(current && !current.conv.temporary ? [{ label: "Arquivar conversa", icon: "archive", run: () => setArchived(current.conv, true) }] : []),
    ];
    const byScore = <T,>(get: (x: T) => string) => (a: T, b: T) => score(get(b), nq) - score(get(a), nq);
    const acts = actions.filter((a) => !tq || score(a.label, nq)).sort(byScore((a) => a.label));
    const cs = tq ? convs.filter((c) => score(c.title, nq)).sort(byScore((c) => c.title)).slice(0, 8) : convs.slice(0, 7);
    const seen = new Set(cs.map((c) => c.id));
    const results = server.q === tq ? server.results : [];
    const msgs = tq ? results.filter((r) => r.snippet && !seen.has(r.conversation_id)).slice(0, 8) : [];

    const convRows: Row[] = cs.map((c) => ({
      key: "c" + c.id,
      icon: c.kind === "code" ? "code" : "chat",
      title: <Mark text={c.title || "Nova conversa"} q={tq} />,
      when: relTime(c.updated_at),
      run: () => openConversation(c.id),
    }));
    const msgRows: Row[] = msgs.map((r) => ({
      key: "m" + r.message_id,
      icon: "search",
      title: r.title || "Conversa",
      snippet: <Mark text={r.snippet} q={tq} />,
      when: relTime(r.updated_at),
      run: () => openConversation(r.conversation_id, { messageId: r.message_id }),
    }));
    const actRows: Row[] = acts.map((a) => ({ key: "a" + a.label, icon: a.icon, title: <Mark text={a.label} q={tq} />, k: a.kbd, run: a.run }));
    const secs: [string, Row[], number][] = tq
      ? [
          ["Conversas", convRows, Math.max(0, ...cs.map((c) => score(c.title, nq)))],
          ["Nas mensagens", msgRows, msgRows.length ? 0.5 : 0],
          ["Ações", actRows, Math.max(0, ...acts.map((a) => score(a.label, nq)))],
        ]
      : [
          ["Recentes", convRows, 1],
          ["Ações", actRows, 1],
        ];
    return secs.sort((a, b) => b[2] - a[2]).filter(([, rows]) => rows.length);
  }, [tq, convs, current, server]);

  useLayoutEffect(() => navRef.current?.set(0), [sections]);

  return (
    <DialogShell id={id} className="palette">
      <div className="palette-input">
        <Ic name="search" />
        <input
          placeholder="Buscar conversas ou executar uma ação…"
          aria-label="Buscar"
          autoFocus
          spellCheck={false}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => navRef.current?.key(e)}
        />
      </div>
      <div className="palette-list" role="listbox" ref={listRef}>
        {sections.map(([title, rows]) => [
          <div key={"h" + title} className="menu-h">
            {title}
          </div>,
          ...rows.map((r) => (
            <button
              key={r.key}
              type="button"
              className="palette-item"
              role="option"
              onClick={() => {
                close();
                r.run();
              }}
            >
              <Ic name={r.icon} />
              <span className="lbl">
                <span className="t">{r.title}</span>
                {r.snippet && <span className="snip">{r.snippet}</span>}
              </span>
              {r.when && <span className="when">{r.when}</span>}
              {r.k && <kbd>{kbd(r.k)}</kbd>}
            </button>
          )),
        ])}
        {!sections.length && <div className="palette-empty">{tq ? `Nada encontrado para “${tq}”.` : "Nenhuma conversa ainda."}</div>}
      </div>
      <div className="palette-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd>navegar
        </span>
        <span>
          <kbd>↵</kbd>abrir
        </span>
        <span>
          <kbd>esc</kbd>fechar
        </span>
      </div>
    </DialogShell>
  );
}
