import { tr, useLanguage } from "./lib/i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { AgentDialog, AgentPanel } from "./components/Agent";
import { RoomDialog } from "./components/Room";
import { ConfirmDialog, MenuLayer, Toasts, Tooltip } from "./components/Overlay";
import { Palette } from "./components/Palette";
import { SettingsDialog } from "./components/Settings";
import { Sidebar, startRename } from "./components/Sidebar";
import { AmbientCanvas, Main } from "./components/Stage";
import { Ic } from "./lib/icons";
import { copyText, isMobile } from "./lib/util";
import {
  applySettings,
  goArea,
  lastAssistantText,
  loadState,
  newChat,
  onServerEvent,
  openConversation,
  removeConversation,
  route,
  setSidebar,
  sidebarOrder,
  stop,
  toggleSidebar,
  view,
} from "./state/actions";
import { addFiles, composerInput } from "./state/composer";
import { S, setS, useApp } from "./state/store";
import { closeMenu, closeTopDialog, isDialogOpen, isPopoverOpen, openPalette, openSettings, toast, useUi } from "./state/ui";

// ------------------------------------------------------------------ keyboard

function onKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const ae = document.activeElement as HTMLElement | null;
  const inField = /INPUT|TEXTAREA|SELECT/.test(ae?.tagName || "") || !!ae?.isContentEditable;

  if (mod && k === "k") {
    e.preventDefault();
    if (!isDialogOpen()) {
      closeMenu();
      openPalette();
    } else closeTopDialog();
    return;
  }
  if (isDialogOpen()) return; // dialogs handle their own Escape
  if (mod && e.shiftKey && k === "o") { e.preventDefault(); newChat(); return; }
  if (mod && e.shiftKey && (e.code === "Digit1" || e.code === "Digit2")) { e.preventDefault(); goArea(e.code === "Digit1" ? "chat" : "code"); return; }
  if (mod && !e.shiftKey && k === "b") { e.preventDefault(); toggleSidebar(); return; }
  if (mod && (e.key === "." || e.code === "Period")) { e.preventDefault(); closeMenu(); view.openModelPicker(); return; }
  if (mod && e.key === ",") { e.preventDefault(); openSettings("general"); return; }
  if (mod && (e.key === "/" || e.code === "Slash")) { e.preventDefault(); openSettings("shortcuts"); return; }
  if (mod && e.shiftKey && k === "c") {
    if (window.getSelection()?.toString()) return;
    const t = lastAssistantText();
    if (t) {
      e.preventDefault();
      copyText(t).then(() => toast(tr("Última resposta copiada")));
    }
    return;
  }
  if (mod && e.shiftKey && e.key === "Backspace" && S().current && !S().current!.conv.agent_id) {
    e.preventDefault();
    const id = S().current!.conv.id;
    removeConversation(S().convs.find((x) => x.id === id) || S().current!.conv);
    return;
  }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const list = sidebarOrder();
    if (!list.length) return;
    const cur = S().current;
    const i = cur ? list.findIndex((c) => c.id === cur.conv.id) : -1;
    const next = e.key === "ArrowDown" ? list[Math.min(list.length - 1, i + 1)] : list[Math.max(0, i - 1)];
    if (next) openConversation(next.id);
    return;
  }
  if (e.key === "F2" && !inField && S().current && !(ae?.closest(".conv"))) {
    e.preventDefault();
    const id = S().current!.conv.id;
    if (document.querySelector(`.conv[data-id="${id}"]`)) startRename(id);
    else dispatchEvent(new Event("ceu:rename-title"));
    return;
  }
  if (e.shiftKey && e.key === "Escape") { e.preventDefault(); composerInput.el?.focus(); return; }
  if (e.key === "Escape" && !isPopoverOpen()) {
    if (document.documentElement.dataset.drawer === "open") { setSidebar(false); return; }
    if (S().generating.length && !inField) { stop(); return; }
  }
  // Type-to-focus: printable keys anywhere go to the composer.
  if (!inField && !mod && !e.altKey && e.key.length === 1 && !isPopoverOpen()) composerInput.el?.focus();
}

// ------------------------------------------------------------------ drag & drop

function useFileDrop() {
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      useUi.setState({ dropping: true });
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) useUi.setState({ dropping: false });
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      useUi.setState({ dropping: false });
      if (!isDialogOpen()) addFiles(Array.from(e.dataTransfer!.files));
    };
    addEventListener("dragenter", enter);
    addEventListener("dragover", over);
    addEventListener("dragleave", leave);
    addEventListener("drop", drop);
    return () => {
      removeEventListener("dragenter", enter);
      removeEventListener("dragover", over);
      removeEventListener("dragleave", leave);
      removeEventListener("drop", drop);
    };
  }, []);
}

// ------------------------------------------------------------------ layer

function Layer() {
  useLanguage();
  const dialogs = useUi((s) => s.dialogs);
  return (
    <div id="layer">
      {dialogs.map((d) =>
        d.kind === "palette" ? (
          <Palette key={d.id} id={d.id} />
        ) : d.kind === "settings" ? (
          <SettingsDialog key={d.id} id={d.id} section={d.section} focus={d.focus} />
        ) : d.kind === "agent" ? (
          <AgentDialog key={d.id} id={d.id} agentId={d.agentId} />
        ) : d.kind === "room" ? (
          <RoomDialog key={d.id} id={d.id} convId={d.convId} />
        ) : (
          <ConfirmDialog key={d.id} {...d} />
        ),
      )}
      <MenuLayer />
    </div>
  );
}

function DropOverlay() {
  useLanguage();
  const dropping = useUi((s) => s.dropping);
  return (
    <div className={"drop-overlay" + (dropping ? " is-visible" : "")}>
      <div>
        <Ic name="attach" />
        {tr("Solte para anexar")}</div>
    </div>
  );
}

// ------------------------------------------------------------------ boot

/** The Python server starts alongside the app (Tauri sidecar) — wait for it instead of failing. */
async function waitForServer(onRetry: (n: number) => void) {
  for (let n = 0; ; n++) {
    try {
      await loadState();
      return;
    } catch (e) {
      if (n >= 40) throw e;
      onRetry(n);
      await new Promise((r) => setTimeout(r, n < 10 ? 300 : 1000));
    }
  }
}

export default function App() {
  useLanguage();
  const [phase, setPhase] = useState<"boot" | "slow" | "ready" | "error">("boot");
  const [error, setError] = useState("");
  const dialogOpen = useUi((s) => s.dialogs.length > 0);
  const agentOpen = useApp((s) => !!s.current?.conv.agent_id);
  const appRef = useRef<HTMLDivElement>(null);
  useFileDrop();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await waitForServer((n) => n >= 3 && alive && setPhase("slow"));
      } catch (e: any) {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
        return;
      }
      if (!alive) return;
      applySettings();
      const [convs, agents] = await Promise.all([api.conversations().catch(() => []), api.agents().catch(() => [])]);
      setS({ convs, agents });
      setPhase("ready");
      api.events(onServerEvent);
      route();
      if (isMobile()) setSidebar(false);
    })();
    const onPop = () => route({ push: false });
    addEventListener("popstate", onPop);
    document.addEventListener("keydown", onKeydown);
    return () => {
      alive = false;
      removeEventListener("popstate", onPop);
      document.removeEventListener("keydown", onKeydown);
    };
  }, []);

  // Everything behind a modal is inert: no focus, no typing into the composer.
  useEffect(() => {
    if (appRef.current) appRef.current.inert = dialogOpen;
  }, [dialogOpen]);

  if (phase !== "ready")
    return (
      <div className="boot">
        <AmbientCanvas />
        <div className="boot-card">
          {phase === "error" ? (
            <>
              <b>{tr("Não foi possível falar com o servidor do CEU.")}</b>
              <span>{error}</span>
              <button className="btn" onClick={() => location.reload()}>
                {tr("Tentar novamente")}</button>
            </>
          ) : (
            <>
              <span className="cube-wrap">
                <span className="cube">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              {phase === "slow" && <span>{tr("Iniciando o servidor…")}</span>}
            </>
          )}
        </div>
      </div>
    );

  return (
    <>
      <AmbientCanvas />
      <div className={"app" + (agentOpen ? " has-agent" : "")} id="app" ref={appRef}>
        <Sidebar />
        <div className="scrim" onClick={() => setSidebar(false)} />
        <Main />
        {agentOpen && <AgentPanel />}
      </div>
      <DropOverlay />
      <Layer />
      <Toasts />
      <Tooltip />
    </>
  );
}
