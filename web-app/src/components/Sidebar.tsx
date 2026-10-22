import { tr, useLanguage } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import type { Conversation } from "../api";
import { Ic, Icon } from "../lib/icons";
import { cx, dateGroup, isMobile } from "../lib/util";
import { exportConversation, goArea, newChat, newCodeSession, openConversation, openRoomDialog, removeConversation, rename, setArchived, setSidebar, sortedConvs, togglePin } from "../state/actions";
import { areaOf, setS, useApp, type Area } from "../state/store";
import { api } from "../api";
import { openMenu, openPalette, openSettings, type MenuItem } from "../state/ui";
import { create } from "zustand";
import { AgentsSection } from "./Agent";

/** which conversation is being renamed inline in the sidebar (null = none) */
export const useRenaming = create<{ id: string | null }>(() => ({ id: null }));
export const startRename = (id: string) => useRenaming.setState({ id });

export function towerBlocks(count: number | undefined) {
  // 1 block per "size step": short chats read as 1, long ones cap at 5
  return Math.max(1, Math.min(5, Math.ceil(Math.log2((count || 1) + 1) - 0.4)));
}

export function convMenuItems(c: Conversation, onRename: () => void): MenuItem[] {
  if (c.temporary)
    return [
      { label: tr("Exportar como Markdown"), icon: "download", key: "e", onSelect: () => exportConversation(c) },
      "sep",
      { label: tr("Excluir"), icon: "trash", danger: true, key: "d", onSelect: () => removeConversation(c) },
    ];
  return [
    { label: c.pinned ? tr("Desafixar") : tr("Fixar"), icon: c.pinned ? "unpin" : "pin", key: "p", onSelect: () => togglePin(c) },
    { label: tr("Renomear"), icon: "rename", key: "r", onSelect: onRename },
    { label: tr("Exportar como Markdown"), icon: "download", key: "e", onSelect: () => exportConversation(c) },
    { label: tr("Arquivar"), icon: "archive", key: "a", onSelect: () => setArchived(c, true) },
    "sep",
    { label: tr("Excluir"), icon: "trash", danger: true, key: "d", onSelect: () => removeConversation(c) },
  ];
}

async function saveListPref(patch: { sidebar_sort?: "updated" | "created"; sidebar_group?: "date" | "none" | "project" }) {
  setS((st) => ({ settings: { ...st.settings, ...patch } }));
  api.settings(patch).catch(() => {});
}

function listMenu(anchor: HTMLElement, sort: string, group: string) {
  openMenu({
    anchor,
    placement: "bottom-end",
    items: [
      { header: tr("Ordenar por") },
      { label: tr("Última atividade"), checked: sort === "updated", onSelect: () => saveListPref({ sidebar_sort: "updated" }) },
      { label: tr("Data de criação"), checked: sort === "created", onSelect: () => saveListPref({ sidebar_sort: "created" }) },
      "sep",
      { header: tr("Agrupar por") },
      { label: tr("Data"), checked: group === "date", onSelect: () => saveListPref({ sidebar_group: "date" }) },
      { label: tr("Projeto"), checked: group === "project", onSelect: () => saveListPref({ sidebar_group: "project" }) },
      { label: tr("Nenhum"), checked: group === "none", onSelect: () => saveListPref({ sidebar_group: "none" }) },
    ],
  });
}

function RenameInput({ c }: { c: Conversation }) {
  useLanguage();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current!.value.trim();
    useRenaming.setState({ id: null });
    if (save && v && v !== c.title) rename(c.id, v);
  };
  return (
    <input
      ref={ref}
      className="rename"
      defaultValue={c.title}
      aria-label={tr("Novo título")}
      maxLength={120}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}

function ConvItem({ c, active, isNew }: { c: Conversation; active: boolean; isNew: boolean }) {
  useLanguage();
  const renaming = useRenaming((s) => s.id === c.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = (opts: { anchor?: HTMLElement; x?: number; y?: number; placement?: "bottom-start" }) => {
    setMenuOpen(true);
    openMenu({ ...opts, items: convMenuItems(c, () => startRename(c.id)), onClose: () => setMenuOpen(false) });
  };
  return (
    <a
      className={cx("conv", active && "is-active", c.streaming && "is-streaming", isNew && "is-new", menuOpen && "menu-open")}
      href={`#/c/${c.id}`}
      role="listitem"
      data-id={c.id}
      aria-current={active ? "page" : undefined}
      draggable={false}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest(".more") || t.closest("input")) return;
        e.preventDefault();
        openConversation(c.id);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        startRename(c.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key === "F2") {
          e.preventDefault();
          startRename(c.id);
        }
      }}
    >
      <span className={cx("tower", c.kind === "code" && "is-code", c.room && "is-room")} aria-hidden="true">
        {Array.from({ length: towerBlocks(c.message_count) }, (_, i) => (
          <i key={i} />
        ))}
      </span>
      {renaming ? (
        <RenameInput c={c} />
      ) : (
        <span className="t" title={c.title}>
          {c.title || tr("Nova conversa")}
        </span>
      )}
      {!!c.pinned && (
        <span className="pin-glyph">
          <Icon name="pin" />
        </span>
      )}
      {!c.pinned && (
        <button
          type="button"
          className="more pin-now"
          aria-label={tr("Fixar")}
          data-tip={tr("Fixar")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePin(c);
          }}
        >
          <Icon name="pin" />
        </button>
      )}
      <button
        type="button"
        className="more"
        aria-label={tr("Opções")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          menu({ anchor: e.currentTarget, placement: "bottom-start" });
        }}
      >
        <Icon name="more" />
      </button>
    </a>
  );
}

/** Main destinations. Chat holds conversations and agents; Code holds sessions on a folder. */
const AREAS: { id: Area; label: string; icon: string; kbd: string }[] = [
  { id: "chat", label: "Chat", icon: "chat", kbd: "Ctrl ⇧ 1" },
  { id: "code", label: "Code", icon: "code", kbd: "Ctrl ⇧ 2" },
];

function AreaNav({ area }: { area: Area }) {
  useLanguage();
  // approvals waiting in agent threads stay visible from Code
  const pending = useApp((s) => s.agents.reduce((n, a) => n + (a.pending || 0), 0));
  return (
    <nav className="sb-nav" aria-label={tr("Áreas")}>
      {AREAS.map((a) => (
        <button
          key={a.id}
          type="button"
          className={cx("sb-action sb-nav-item", a.id === area && "is-active")}
          aria-current={a.id === area ? "page" : undefined}
          data-tip={a.label}
          data-tip-rail
          data-kbd={a.kbd}
          onClick={() => goArea(a.id)}
        >
          <Ic name={a.icon} />
          <span className="lbl">{a.label}</span>
          {a.id === "chat" && area !== "chat" && pending > 0 && <span className="agent-badge">{pending}</span>}
        </button>
      ))}
    </nav>
  );
}

export function Sidebar() {
  useLanguage();
  const allConvs = useApp((s) => s.convs);
  const sort = useApp((s) => s.settings.sidebar_sort);
  const grouping = useApp((s) => s.settings.sidebar_group);
  const area = useApp((s) => areaOf(s));
  const code = area === "code";
  const convs = sortedConvs(allConvs, sort).filter((c) => (c.kind === "code") === code);
  const activeId = useApp((s) => s.current?.conv.id);
  // conversations present at the previous render — anything else animates in
  const seen = useRef<Set<string> | null>(null);
  const prevSeen = seen.current;
  useEffect(() => {
    seen.current = new Set(allConvs.map((c) => c.id));
  }, [allConvs]);

  const groups = new Map<string, Conversation[]>();
  const pinned = convs.filter((c) => c.pinned);
  if (pinned.length) groups.set(tr("Fixadas"), pinned);
  for (const c of convs) {
    if (c.pinned) continue;
    const g =
      grouping === "none"
        ? code ? tr("Sessões") : tr("Conversas")
        : grouping === "project"
          ? c.kind === "code" && c.project_path
            ? c.project_path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || c.project_path
            : tr("Conversas")
          : dateGroup(sort === "created" ? c.created_at : c.updated_at);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }

  return (
    <aside className="sidebar" id="sidebar" aria-label={tr("Navegação")}>
      <div className="sb-head">
        <a
          className="brand"
          href="#/"
          aria-label="CEU"
          onClick={(e) => {
            e.preventDefault();
            if (document.documentElement.dataset.sidebar === "closed" && !isMobile()) setSidebar(true);
            else newChat();
          }}
        >
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M4 7.4 12 12l8-4.6M12 12v9.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity=".55" />
          </svg>
          <span>CEU</span>
        </a>
        <button className="icon-btn" id="sb-collapse" data-tip={tr("Recolher barra lateral")} data-kbd="Ctrl B" aria-label={tr("Recolher barra lateral")} onClick={() => setSidebar(false)}>
          <Icon name="sidebar" />
        </button>
        <button className="icon-btn" id="sb-expand" data-tip-rail data-tip={tr("Abrir barra lateral")} data-kbd="Ctrl B" aria-label={tr("Abrir barra lateral")} onClick={() => setSidebar(true)}>
          <Icon name="sidebar" />
        </button>
      </div>
      <AreaNav area={area} />
      <div className="sb-actions">
        <button className="sb-action" data-tip-rail data-tip={code ? tr("Nova sessão") : tr("Nova conversa")} data-kbd="Ctrl ⇧ O" onClick={() => (code ? newCodeSession() : newChat())}>
          <Ic name="new" />
          <span className="lbl">{code ? tr("Nova sessão") : tr("Nova conversa")}</span>
          <kbd>Ctrl ⇧ O</kbd>
        </button>
        {!code && (
          <button className="sb-action" data-tip-rail data-tip={tr("Nova Room: vários modelos em sequência")} onClick={() => openRoomDialog()}>
            <Ic name="chat" />
            <span className="lbl">{tr("Nova Room")}</span>
          </button>
        )}
        <button className="sb-action" data-tip-rail data-tip={tr("Buscar")} data-kbd="Ctrl K" onClick={() => openPalette()}>
          <Ic name="search" />
          <span className="lbl">{tr("Buscar")}</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
      {!code && <AgentsSection />}
      {convs.length > 0 && (
        <div className="sb-list-head">
          <span>{code ? tr("Sessões") : tr("Histórico")}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={tr("Ordenar e agrupar")}
            data-tip={tr("Ordenar e agrupar")}
            onClick={(e) => listMenu(e.currentTarget, sort, grouping)}
          >
            <Icon name="filter" />
          </button>
        </div>
      )}
      <div className="sb-list" role="list">
        {!convs.length ? (
          <div className="sb-empty">{code ? tr("Suas sessões de código aparecem aqui.") : tr("Suas conversas aparecem aqui.")}</div>
        ) : (
          [...groups].map(([label, list]) => (
            <div key={label} className="sb-group" role="group" aria-label={label}>
              <div className="sb-group-h">{label}</div>
              {list.map((c) => (
                <ConvItem key={c.id} c={c} active={c.id === activeId} isNew={!!prevSeen && !prevSeen.has(c.id)} />
              ))}
            </div>
          ))
        )}
      </div>
      <div className="sb-foot">
        <button className="sb-action" data-tip-rail data-tip={tr("Configurações")} data-kbd="Ctrl ," onClick={() => openSettings("general")}>
          <Ic name="settings" />
          <span className="lbl">{tr("Configurações")}</span>
          <kbd>Ctrl ,</kbd>
        </button>
      </div>
    </aside>
  );
}
