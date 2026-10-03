import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "../api";
import { Ambient, HistoryField } from "../lib/field";
import { Icon } from "../lib/icons";
import { copyText, cx, reducedMotion, relTime } from "../lib/util";
import { newChat, onThemeChange, openConversation, openProjectFolder, rename, setSidebar, setTemporary, view } from "../state/actions";
import { describeSchedule } from "../state/agents";
import { S, areaOf, currentRuntime, useApp } from "../state/store";
import { openMenu, toast } from "../state/ui";
import { agentMenuItems } from "./Agent";
import { Dock, folderName } from "./Composer";
import { RoomBadge } from "./Room";
import { convMenuItems } from "./Sidebar";
import { Thread } from "./Thread";

// ------------------------------------------------------------------ ambient space

export function AmbientCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const amb = useRef<Ambient | null>(null);
  const enabled = useApp((s) => s.settings.ambient !== false);
  const generating = useApp((s) => s.generating.length > 0);

  useEffect(() => {
    const a = new Ambient(ref.current!);
    amb.current = a;
    const off = onThemeChange(() => a.refreshTheme());
    return () => {
      off();
      a.destroy();
    };
  }, []);
  useEffect(() => amb.current?.setEnabled(enabled && !reducedMotion()), [enabled]);
  useEffect(() => amb.current?.setActivity(generating ? 1 : 0), [generating]);

  return <canvas id="ambient" ref={ref} aria-hidden="true" />;
}

// ------------------------------------------------------------------ history field (empty state)

function FieldLabel({ hover, count, code }: { hover: Conversation | null; count: number; code: boolean }) {
  if (hover)
    return (
      <>
        <b>{hover.title || "Nova conversa"}</b>
        {relTime(hover.updated_at)} · {hover.message_count} mensage{hover.message_count === 1 ? "m" : "ns"}
      </>
    );
  if (!count) return null;
  const noun = code ? (count === 1 ? "Sessão recente" : `${count} sessões recentes`) : count === 1 ? "Conversa recente" : `${count} conversas recentes`;
  return <>{noun} — altura indica o tamanho</>;
}

function Empty({ active }: { active: boolean }) {
  const allConvs = useApp((s) => s.convs);
  const code = useApp((s) => areaOf(s) === "code");
  // the field shows the area's own history
  const convs = useMemo(() => allConvs.filter((c) => (c.kind === "code") === code), [allConvs, code]);
  const ref = useRef<HTMLCanvasElement>(null);
  const field = useRef<HistoryField | null>(null);
  const [label, setLabel] = useState<{ hover: Conversation | null; count: number }>({ hover: null, count: 0 });

  useEffect(() => {
    const f = new HistoryField(ref.current!, { onOpen: (id) => openConversation(id), onHover: (hover, count) => setLabel({ hover, count }) });
    field.current = f;
    const off = onThemeChange(() => f.refreshTheme());
    return () => {
      off();
      f.destroy();
    };
  }, []);
  useEffect(() => {
    if (active) field.current?.setData(convs);
  }, [convs, active]);

  return (
    <div className="empty">
      <div className="field-wrap" hidden={!convs.length}>
        <canvas id="field" ref={ref} aria-hidden="true" />
        <div className="field-label" aria-live="polite">
          <FieldLabel {...label} code={code} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ topbar

function TitleButton() {
  const conv = useApp((s) => s.current?.conv);
  const convs = useApp((s) => s.convs);
  const [editing, setEditing] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const lastAnim = useRef(view.titleAnim);
  const title = conv?.title || "Nova conversa";

  useEffect(() => {
    document.title = conv ? `${title} — CEU` : "CEU";
  }, [conv, title]);
  useLayoutEffect(() => {
    if (view.titleAnim !== lastAnim.current) {
      lastAnim.current = view.titleAnim;
      setAnimKey((k) => k + 1);
    }
  });
  useEffect(() => {
    const on = () => setEditing(true);
    addEventListener("ceu:rename-title", on);
    return () => removeEventListener("ceu:rename-title", on);
  }, []);

  if (!conv) return null;
  if (editing) return <TitleInput id={conv.id} title={conv.title} onDone={() => setEditing(false)} />;
  return (
    <button
      className={"title-btn" + (animKey ? " is-new" : "")}
      onClick={(e) => {
        if (conv.agent_id) {
          // agent threads belong to the agent: its menu, not the conversation's
          const a = S().agents.find((x) => x.id === conv.agent_id);
          if (a) openMenu({ anchor: e.currentTarget, placement: "bottom-start", items: agentMenuItems(a) });
          return;
        }
        const c = convs.find((x) => x.id === conv.id) || conv;
        openMenu({ anchor: e.currentTarget, placement: "bottom-start", items: convMenuItems(c, () => setEditing(true)) });
      }}
      onDoubleClick={() => !conv.agent_id && setEditing(true)}
    >
      <span className="t" key={animKey}>
        {title}
      </span>
      <span className="ic">
        <Icon name="chevron-down" />
      </span>
    </button>
  );
}

function TitleInput({ id, title, onDone }: { id: string; title: string; onDone: () => void }) {
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
    onDone();
    if (save && v && v !== title) rename(id, v);
  };
  return (
    <input
      ref={ref}
      className="input"
      defaultValue={title}
      style={{ height: 30, width: "min(420px, 50vw)" }}
      aria-label="Título da conversa"
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** Code session: the folder (and git branch) the agent works in. */
function ProjectBadge() {
  const conv = useApp((s) => s.current?.conv);
  if (!conv || conv.kind !== "code" || !conv.project_path) return null;
  const path = conv.project_path;
  return (
    <button
      type="button"
      className={cx("project-badge", conv.project_exists === false && "is-missing")}
      data-tip={conv.project_exists === false ? "Pasta não encontrada" : path}
      onClick={(e) =>
        openMenu({
          anchor: e.currentTarget,
          placement: "bottom-start",
          items: [
            { header: path },
            { label: "Abrir no Explorer", icon: "external", disabled: conv.project_exists === false, onSelect: () => openProjectFolder(path) },
            { label: "Copiar caminho", icon: "copy", onSelect: () => copyText(path).then(() => toast("Caminho copiado")) },
          ],
        })
      }
    >
      <Icon name="archive" />
      <span className="n">{folderName(path)}</span>
      {conv.git_branch && (
        <span className="br">
          <Icon name="branch" />
          {conv.git_branch}
        </span>
      )}
    </button>
  );
}

/** Code session run by another harness than CEU's own loop: say which. */
function RuntimeBadge() {
  const rt = useApp((s) => (s.current?.conv.kind === "code" ? currentRuntime(s) : null));
  if (!rt || rt.id === "ceu") return null;
  return (
    <span className="runtime-badge" data-tip={rt.detail}>
      <Icon name={rt.family === "redir" ? "external" : "cube"} />
      {rt.family === "redir" ? `REDIR · ${rt.name}` : rt.name}
    </span>
  );
}

/** Task thread: which agent it belongs to, and when it runs. */
function TaskBadge() {
  const conv = useApp((s) => s.current?.conv);
  if (conv?.kind !== "agent_task" || !conv.agent) return null;
  return (
    <span className="task-badge">
      <span className="a">{conv.agent.name}</span>
      {conv.task && <span className="s">{conv.task.kind === "research" ? "pesquisa proativa" : describeSchedule(conv.task.schedule).toLowerCase()}</span>}
    </span>
  );
}

/** A Code session or agent task started by a delegated call (`@Code`, `@Agent`): back to where it came from. */
function OriginBadge() {
  const origin = useApp((s) => s.current?.conv.origin || null);
  if (!origin) return null;
  return (
    <button
      type="button"
      className="origin-badge"
      data-tip="Pedido feito numa conversa do Chat; o resultado volta para lá"
      onClick={() => openConversation(origin.conversation_id, { messageId: origin.message_id })}
    >
      <Icon name="chat" />
      <span>Chamado de</span>
      <b>{origin.title || "uma conversa"}</b>
    </button>
  );
}

/** Narrow windows: the agent's activity panel opens over the thread. */
function PanelToggle() {
  const agent = useApp((s) => !!s.current?.conv.agent_id);
  const pending = useApp((s) => (s.agentDetail ? s.agentDetail.approvals.length + s.agentDetail.tasks.filter((t) => t.status === "blocked").length : 0));
  if (!agent) return null;
  return (
    <button
      type="button"
      className={cx("icon-btn panel-toggle", pending > 0 && "has-pending")}
      data-tip="Atividade do agente"
      aria-label="Atividade do agente"
      onClick={() => {
        const root = document.documentElement;
        root.dataset.agentPanel = root.dataset.agentPanel === "open" ? "closed" : "open";
      }}
    >
      <Icon name="sliders" />
    </button>
  );
}

function TempToggle() {
  const empty = useApp((s) => !s.current);
  const code = useApp((s) => !s.current && s.pendingKind === "code");
  const temp = useApp((s) => (s.current ? !!s.current.conv.temporary : s.pendingTemporary));
  if (code || (!empty && !temp)) return null;
  const tip = temp ? (empty ? "Desativar conversa temporária" : "Sair da conversa temporária") : "Conversa temporária";
  return (
    <button type="button" className={cx("temp-toggle", temp && "is-on")} data-tip={tip} aria-label={tip} aria-pressed={temp} onClick={() => setTemporary(!temp)}>
      <Icon name="ghost" />
      {temp && <span>Temporária</span>}
    </button>
  );
}

function Topbar() {
  return (
    <header className="topbar">
      <button className="icon-btn only-collapsed" data-tip="Abrir barra lateral" data-kbd="Ctrl B" aria-label="Abrir barra lateral" onClick={() => setSidebar(true)}>
        <Icon name="sidebar" />
      </button>
      <button className="icon-btn only-mobile" aria-label="Menu" onClick={() => setSidebar(true)}>
        <Icon name="menu" />
      </button>
      <TitleButton />
      <ProjectBadge />
      <RuntimeBadge />
      <TaskBadge />
      <RoomBadge />
      <OriginBadge />
      <div className="grow" />
      <PanelToggle />
      <TempToggle />
      <button className="icon-btn only-collapsed-or-mobile" data-tip="Nova conversa" data-kbd="Ctrl ⇧ O" aria-label="Nova conversa" onClick={() => newChat()}>
        <Icon name="new" />
      </button>
    </header>
  );
}

// ------------------------------------------------------------------ main plane

export function Main() {
  const empty = useApp((s) => !s.current);

  // FLIP: the composer glides from the centred empty state to the bottom
  useLayoutEffect(() => {
    const before = view.dockTopBefore;
    view.dockTopBefore = null;
    if (empty || before == null || reducedMotion()) return;
    const dock = document.getElementById("dock");
    if (!dock) return;
    const after = dock.getBoundingClientRect().top;
    if (Math.abs(before - after) > 2)
      dock.animate([{ transform: `translateY(${before - after}px)` }, { transform: "none" }], { duration: 460, easing: "cubic-bezier(.16,1,.3,1)" });
  }, [empty]);

  return (
    <main className={"main" + (empty ? " is-empty" : "")} id="main">
      <Topbar />
      <section className="stage">
        <Empty active={empty} />
        <Thread />
      </section>
      <Dock empty={empty} />
    </main>
  );
}
