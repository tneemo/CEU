import { useEffect, useMemo, useRef, useState } from "react";
import type { EffortInfo, Provider } from "../api";
import { EFFORT_LABELS, allModels, effortFor } from "../api";
import { Icon } from "../lib/icons";
import { listNav } from "./Overlay";
import "./ModelPicker.css";

interface ModelPickerProps {
  providers: Provider[];
  efforts: Record<string, EffortInfo>;
  modelRef: string | null;
  effort: string | null;
  onChange: (patch: { model?: string | null; effort?: string | null }) => void;
  onManage?: () => void;
  /** receives a function that toggles the picker (for the Ctrl+. shortcut) */
  registerToggle?: (fn: () => void) => void;
  /** no model selected is a valid choice (e.g. an external CLI's own default): its label */
  emptyLabel?: string;
  manualModelPrefix?: string;
  autoEfforts?: string[];
}

type View = "models" | "effort";

export function ModelPicker({ providers, efforts, modelRef, effort, onChange, onManage, registerToggle, emptyLabel, manualModelPrefix, autoEfforts }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("models");
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<ReturnType<typeof listNav> | null>(null);

  const models = useMemo(() => allModels(providers), [providers]);
  const current = models.find((m) => m.ref === modelRef) ?? null;
  const manualId = manualModelPrefix && modelRef?.startsWith(manualModelPrefix) && !current ? modelRef.slice(manualModelPrefix.length) : null;
  const currentEffortInfo = effortFor(efforts, current?.ref || (manualId ? modelRef : null)) ||
    (emptyLabel && !modelRef && autoEfforts?.length ? { levels: autoEfforts, default: autoEfforts[0] } : null);
  const currentEffort = currentEffortInfo ? (effort && currentEffortInfo.levels.includes(effort) ? effort : emptyLabel ? null : currentEffortInfo.default) : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.name.toLowerCase().includes(q),
    );
  }, [models, search]);

  const grouped = useMemo(() => {
    const byProvider = new Map<string, typeof filtered>();
    for (const m of filtered) {
      const list = byProvider.get(m.provider.id) ?? [];
      list.push(m);
      byProvider.set(m.provider.id, list);
    }
    return [...byProvider.entries()];
  }, [filtered]);

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  function toggle() {
    setOpen((o) => !o);
    setView("models");
    setSearch("");
  }
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => registerToggle?.(() => toggleRef.current()), [registerToggle]);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocDown, true);
    return () => document.removeEventListener("pointerdown", onDocDown, true);
  }, [open]);

  // keyboard navigation over the rows; highlight the checked row on open/view change
  useEffect(() => {
    const el = menuRef.current;
    if (!open || !el) return;
    const nav = listNav(el);
    navRef.current = nav;
    const rows = Array.from(el.querySelectorAll(".menu-item"));
    nav.set(Math.max(0, rows.findIndex((r) => r.getAttribute("aria-checked") === "true")));
    if (view === "models" && models.length > 6) searchRef.current?.focus();
    else el.focus();
    return () => {
      nav.destroy();
      navRef.current = null;
    };
  }, [open, view, models.length]);

  useEffect(() => {
    if (open && search) navRef.current?.set(0);
  }, [search, open]);

  function pickModel(ref: string | null) {
    onChange({ model: ref, ...(emptyLabel ? { effort: null } : {}) });
    setView("models");
    close();
  }

  function pickEffort(level: string | null) {
    onChange({ effort: level });
    close();
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (view === "effort") setView("models");
      else close(true);
      return;
    }
    if (e.target === manualRef.current) return;
    if (view === "effort" && (e.key === "ArrowLeft" || e.key === "Backspace")) {
      e.preventDefault();
      setView("models");
      return;
    }
    if (navRef.current?.key(e.nativeEvent)) return;
    if (e.key.length === 1 && document.activeElement !== searchRef.current && searchRef.current) searchRef.current.focus();
  };

  const label = current ? current.name : manualId || (emptyLabel ? "Auto" : (models.length ? "Selecionar modelo" : "Conectar um modelo"));
  const effortLabel = currentEffort ? EFFORT_LABELS[currentEffort] ?? currentEffort : null;

  return (
    <div className="model-picker" ref={rootRef} data-popover-open={open ? "" : undefined}>
      <button
        ref={triggerRef}
        type="button"
        id="model-btn"
        className={"model-btn" + (!current && !emptyLabel ? " is-missing" : "")}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip="Trocar modelo"
        data-kbd="Ctrl ."
      >
        <span className="name">{label}</span>
        {effortLabel && <span className="effort">{effortLabel}</span>}
        <span className="ic">
          <Icon name="chevron-down" />
        </span>
      </button>

      {open && (
        <div className={"model-picker-menu menu"} role="menu" ref={menuRef} tabIndex={-1} onKeyDown={onKeyDown}>
          {view === "models" ? (
            <>
              {models.length > 6 && (
                <div className="picker-search">
                  <Icon name="search" />
                  <input
                    ref={searchRef}
                    placeholder="Buscar modelo…"
                    aria-label="Buscar modelo"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              )}
              <div className="model-picker-list">
                {emptyLabel && <button type="button" role="menuitemradio" aria-checked={!current && !manualId} className="menu-item model-picker-row" onClick={() => pickModel(null)}><span className="lbl">Auto<span className="sub">{emptyLabel}</span></span>{!current && !manualId && <span className="ic check"><Icon name="check" /></span>}</button>}
                {manualModelPrefix && <div className="picker-search"><input ref={manualRef} value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) { e.preventDefault(); e.stopPropagation(); pickModel(manualModelPrefix + manual.trim()); } }} placeholder="ID ou alias do modelo" aria-label="ID ou alias do modelo" /><button type="button" disabled={!manual.trim()} onClick={() => pickModel(manualModelPrefix + manual.trim())}>Usar</button></div>}
                {!models.length && (
                  <div className="model-picker-empty">
                    {emptyLabel ? "Este CLI não informou uma lista de modelos; Auto usa a configuração dele." : "Nenhum provedor conectado. Adicione uma chave da Anthropic, OpenAI, OpenRouter ou um servidor local."}
                  </div>
                )}
                {grouped.map(([providerId, items]) => (
                  <div key={providerId}>
                    {grouped.length > 1 && <div className="menu-h">{items[0].provider.name}</div>}
                    {items.map((m) => (
                      <button
                        key={m.ref}
                        type="button"
                        role="menuitemradio"
                        aria-checked={m.ref === current?.ref}
                        className="menu-item model-picker-row"
                        onClick={() => pickModel(m.ref)}
                      >
                        <span className="lbl">
                          {m.name}
                          {m.name !== m.id && <span className="sub">{m.id}</span>}
                        </span>
                        {m.ref === current?.ref && (
                          <span className="ic check">
                            <Icon name="check" />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
                {models.length > 0 && filtered.length === 0 && <div className="model-picker-empty">Nenhum modelo encontrado.</div>}
              </div>

              {(currentEffortInfo || onManage) && (
                <div className="model-picker-foot">
              {currentEffortInfo && (
                <>
                  <button type="button" className="menu-item model-picker-row" onClick={() => setView("effort")} title="Quanto o modelo raciocina antes de responder">
                    <span className="lbl">Esforço</span>
                    <span className="model-picker-row-aside">
                      {effortLabel}
                      <Icon name="chevron-right" />
                    </span>
                  </button>
                </>
              )}
              {onManage && (
                <>
                  <button
                    type="button"
                    className="menu-item model-picker-row model-picker-manage"
                    onClick={() => {
                      close();
                      onManage();
                    }}
                  >
                    <span className="ic">
                      <Icon name="sliders" />
                    </span>
                    <span className="lbl">Gerenciar provedores</span>
                  </button>
                </>
              )}
                </div>
              )}
            </>
          ) : (
            <>
              <button type="button" className="model-picker-back" onClick={() => setView("models")}>
                <Icon name="chevron-left" />
                <span>{current?.name}</span>
              </button>
              <div className="menu-sep" />
              <div className="model-picker-list">
                {emptyLabel && <button type="button" role="menuitemradio" aria-checked={!currentEffort} className="menu-item model-picker-row" onClick={() => pickEffort(null)}><span className="lbl">Auto</span>{!currentEffort && <span className="ic check"><Icon name="check" /></span>}</button>}
                {(currentEffortInfo?.levels ?? []).map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={level === currentEffort}
                    className="menu-item model-picker-row"
                    onClick={() => pickEffort(level)}
                  >
                    <span className="lbl">{EFFORT_LABELS[level] ?? level}</span>
                    {level === currentEffort && (
                      <span className="ic check">
                        <Icon name="check" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
