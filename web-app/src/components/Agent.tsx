// CEU Agent: sidebar section, activity panel (approvals, tasks, notes, access),
// the create/edit dialog and the agent thread's intro. See docs/referencias-agent.md.
import { useEffect, useRef, useState } from "react";
import { api, type Agent, type AgentAction, type AgentApproval, type AgentDecision, type AgentDetail, type AgentEvent, type AgentNote, type AgentTask, type Schedule } from "../api";
import { Ic, Icon } from "../lib/icons";
import { autosize, cx, relTime } from "../lib/util";
import {
  addNote,
  answerParked,
  createTask,
  describeSchedule,
  editAgent,
  editNote,
  markTaskDone,
  newAgent,
  openAgent,
  removeAgent,
  removeNote,
  removeTask,
  replyToTask,
  runTask,
  saveAgent,
  setAgentPaused,
  setTaskPaused,
  TASK_STATUS,
  taskGroup,
  type TaskGroup,
} from "../state/agents";
import { openConversation } from "../state/actions";
import { focusComposer, setText } from "../state/composer";
import { allModels, useApp } from "../state/store";
import { closeDialog, openMenu, toast, type MenuItem } from "../state/ui";
import { folderName } from "./Composer";
import { DialogShell } from "./Overlay";

// ------------------------------------------------------------------ helpers

function fmtWhen(ts: number | null) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff === 0) return `hoje ${hm}`;
  if (diff === 1) return `amanhã ${hm}`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + hm;
}

function oneLine(s: string | null | undefined, n = 140) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function agentMenuItems(a: Agent): MenuItem[] {
  return [
    { label: "Editar agente", icon: "sliders", key: "e", onSelect: () => editAgent(a.id) },
    { label: a.paused ? "Retomar agente" : "Pausar agente", icon: a.paused ? "retry" : "stop", key: "p", onSelect: () => setAgentPaused(a, !a.paused) },
    "sep",
    { label: "Excluir agente", icon: "trash", danger: true, key: "d", onSelect: () => removeAgent(a) },
  ];
}

// ------------------------------------------------------------------ sidebar

export function AgentsSection() {
  const agents = useApp((s) => s.agents);
  const activeAgent = useApp((s) => s.current?.conv.agent_id || null);
  return (
    <div className="sb-agents" role="group" aria-label="Agentes">
      <div className="sb-list-head">
        <span>Agentes</span>
        <button type="button" className="icon-btn" aria-label="Novo agente" data-tip="Novo agente" onClick={newAgent}>
          <Icon name="new" />
        </button>
      </div>
      {!agents.length ? (
        <button type="button" className="sb-agent-empty" onClick={newAgent}>
          Um agente trabalha por você em segundo plano, com memória e tarefas próprias.
        </button>
      ) : (
        <div className="sb-agent-list">
          {agents.map((a) => (
            <a
              key={a.id}
              href={`#/c/${a.conversation_id}`}
              className={cx("agent-item", a.id === activeAgent && "is-active", a.running > 0 && "is-running", a.paused && "is-paused")}
              aria-current={a.id === activeAgent ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                openAgent(a);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu({ x: e.clientX, y: e.clientY, items: agentMenuItems(a) });
              }}
            >
              <span className="agent-glyph" aria-hidden="true">
                <i />
              </span>
              <span className="t">{a.name}</span>
              {a.pending > 0 && (
                <span className="agent-badge" data-tip={a.pending === 1 ? "1 item esperando você" : `${a.pending} itens esperando você`}>
                  {a.pending}
                </span>
              )}
              {a.paused && <span className="agent-paused">pausado</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ panel

function Section({ title, count, action, children, collapsed }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="agp-sec">
      <div className="agp-sec-h">
        {collapsed === undefined ? (
          <span>{title}</span>
        ) : (
          <button type="button" className="agp-sec-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name={open ? "chevron-down" : "chevron-right"} />
            {title}
          </button>
        )}
        {!!count && <span className="n">{count}</span>}
        <div className="grow" />
        {action}
      </div>
      {open && children}
    </section>
  );
}

/** A task stopped on a question for the user (update_task blocked, or the continuation limit). */
function BlockedRow({ t }: { t: AgentTask }) {
  const question = t.outcome?.question || t.last_result || "A tarefa precisa de uma decisão sua.";
  return (
    <div className="agp-appr is-question">
      <button type="button" className="agp-appr-what" onClick={() => replyToTask(t)} data-tip="Abrir a tarefa">
        <span className="w">{oneLine(question, 280)}</span>
        <span className="where">
          {t.title} · {relTime(t.updated_at)}
        </span>
      </button>
      <div className="agp-appr-act">
        <button type="button" className="btn primary" onClick={() => replyToTask(t)}>
          Responder
        </button>
        <button type="button" className="btn ghost" onClick={() => runTask(t)}>
          Continuar
        </button>
        <button type="button" className="btn ghost" onClick={() => markTaskDone(t)}>
          Encerrar
        </button>
      </div>
    </div>
  );
}

function ApprovalRow({ a, agent }: { a: AgentApproval; agent: Agent }) {
  const r = a.request;
  const what = r.summary && r.kind === "agent" ? r.summary : r.kind === "command" ? r.input.command : `Editar ${r.preview?.path || r.input.path}`;
  return (
    <div className="agp-appr">
      <button type="button" className="agp-appr-what" onClick={() => openConversation(a.conversation_id)} data-tip="Abrir onde foi pedido">
        <span className="w">{what}</span>
        <span className="where">
          {a.conversation_id === agent.conversation_id ? "Conversa principal" : a.where} · {relTime(a.created_at)}
        </span>
      </button>
      <div className="agp-appr-act">
        <button type="button" className="btn primary" onClick={() => answerParked(a.id, a.conversation_id, "allow")}>
          Permitir
        </button>
        <button type="button" className="btn ghost" onClick={() => answerParked(a.id, a.conversation_id, "deny")}>
          Negar
        </button>
      </div>
    </div>
  );
}

function TaskGlyph({ t }: { t: AgentTask }) {
  return <span className={"task-glyph st-" + t.status} aria-hidden="true" />;
}

function taskMeta(t: AgentTask) {
  if (t.status === "running") return "Rodando agora";
  if (t.status === "waiting") return "Esperando sua aprovação";
  if (t.status === "blocked") return "Precisa de você";
  if (t.status === "paused") return "Pausada";
  if (t.status === "done") return `Concluída ${relTime(t.updated_at)}`;
  // a wake-up the task set for itself, or the next slot of its schedule
  if (t.next_run_at && t.outcome?.state === "continue") return `Continua ${fmtWhen(t.next_run_at)}`;
  if (t.next_run_at) return `${describeSchedule(t.schedule)} · próxima ${fmtWhen(t.next_run_at)}`;
  return `${describeSchedule(t.schedule)}${t.last_run_at ? ` · ${TASK_STATUS[t.status].toLowerCase()} ${relTime(t.last_run_at)}` : ""}`;
}

function TaskRow({ t }: { t: AgentTask }) {
  const current = useApp((s) => s.current?.conv.id === t.conversation_id);
  const busy = t.status === "running" || t.status === "waiting";
  const group = taskGroup(t);
  // in-progress work shows where it stands; the rest, what the last run produced
  const line = group === "active" && t.progress && !busy ? t.progress : t.status !== "running" ? t.last_result : null;
  const menu = (anchor: HTMLElement) =>
    openMenu({
      anchor,
      placement: "bottom-end",
      items: [
        {
          label: t.status === "done" ? "Executar de novo" : group === "active" && t.runs ? "Continuar agora" : "Executar agora",
          icon: "retry",
          disabled: busy,
          onSelect: () => runTask(t),
        },
        t.status === "paused"
          ? { label: "Retomar", icon: "retry", onSelect: () => setTaskPaused(t, false) }
          : { label: "Pausar", icon: "stop", disabled: !t.schedule && !t.next_run_at, onSelect: () => setTaskPaused(t, true) },
        t.status !== "done" && t.kind !== "research" && { label: "Marcar como concluída", icon: "check", disabled: busy, onSelect: () => markTaskDone(t) },
        "sep",
        { label: "Excluir tarefa", icon: "trash", danger: true, onSelect: () => removeTask(t) },
      ],
    });
  return (
    <div className={cx("task-row", current && "is-current", "st-" + t.status)}>
      <button type="button" className="task-main" onClick={() => openConversation(t.conversation_id)}>
        <TaskGlyph t={t} />
        <span className="task-txt">
          <span className="t">
            {t.title}
            {t.kind === "research" && <span className="tag">proativa</span>}
          </span>
          <span className="m">{taskMeta(t)}</span>
          {line && <span className="r">{oneLine(line)}</span>}
        </span>
      </button>
      <button type="button" className="icon-btn task-more" aria-label="Opções da tarefa" onClick={(e) => menu(e.currentTarget)}>
        <Icon name="more" />
      </button>
    </div>
  );
}

type SchedKind = "once" | "hourly" | "hours" | "daily";

function TaskForm({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<SchedKind>("once");
  const [hours, setHours] = useState(6);
  const [time, setTime] = useState("08:00");
  const [busy, setBusy] = useState(false);
  const schedule = (): Schedule =>
    kind === "once" ? null : kind === "hourly" ? { every_minutes: 60 } : kind === "hours" ? { every_minutes: Math.max(1, hours) * 60 } : { daily_at: time };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !instructions.trim()) return;
    setBusy(true);
    try {
      await createTask(agentId, { title, instructions, schedule: schedule(), start_now: kind === "once" });
      toast(kind === "once" ? "Trabalho começou" : "Tarefa agendada");
      onDone();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="agp-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onDone())}>
      <input className="input" autoFocus placeholder="Título (ex.: Resumir notícias de IA)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      <textarea
        className="textarea"
        rows={3}
        placeholder="O objetivo, com detalhes. A tarefa vê isto, as notas do agente e o estado que ela mesma registra a cada execução."
        value={instructions}
        onChange={(e) => {
          setInstructions(e.target.value);
          autosize(e.target, 200);
        }}
      />
      <div className="agp-form-row">
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as SchedKind)} aria-label="Quando rodar">
          <option value="once">Começar agora, sem agenda</option>
          <option value="hourly">A cada hora</option>
          <option value="hours">A cada N horas</option>
          <option value="daily">Todo dia às…</option>
        </select>
        {kind === "hours" && (
          <input className="input num" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(+e.target.value)} aria-label="Horas" />
        )}
        {kind === "daily" && <input className="input num" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Horário" />}
      </div>
      <div className="agp-form-row end">
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancelar
        </button>
        <button type="submit" className="btn primary" disabled={busy || !title.trim() || !instructions.trim()}>
          {kind === "once" ? "Começar" : "Agendar"}
        </button>
      </div>
    </form>
  );
}

function NoteRow({ n }: { n: AgentNote }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing && ref.current) {
      autosize(ref.current, 240);
      ref.current.focus();
    }
  }, [editing]);
  const save = () => {
    const v = ref.current?.value.trim() || "";
    setEditing(false);
    if (v && v !== n.content) editNote(n, v);
  };
  if (editing)
    return (
      <div className="note-row is-editing">
        <textarea
          ref={ref}
          className="textarea"
          defaultValue={n.content}
          onInput={(e) => autosize(e.currentTarget, 240)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
      </div>
    );
  return (
    <div className="note-row">
      <button type="button" className="note-txt" onClick={() => setEditing(true)} data-tip="Editar">
        {n.content}
        {n.source !== "agent" && <span className="src">{n.source === "user" ? "você" : "pesquisa"}</span>}
      </button>
      <button type="button" className="icon-btn note-del" aria-label="Apagar nota" data-tip="Apagar" onClick={() => removeNote(n)}>
        <Icon name="close" />
      </button>
    </div>
  );
}

function NoteAdd({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const save = () => {
    const v = ref.current?.value.trim();
    if (v) addNote(agentId, v);
    onDone();
  };
  return (
    <div className="note-row is-editing">
      <textarea
        ref={ref}
        className="textarea"
        autoFocus
        placeholder="Algo que o agente deve sempre lembrar"
        onInput={(e) => autosize(e.currentTarget, 240)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
      />
    </div>
  );
}

const DECISION_TEXT: Record<AgentDecision, string> = { allow: "livre", ask: "pergunta", block: "bloqueado" };

function AccessSummary({ d }: { d: AgentDetail }) {
  const folder = d.agent.host_folder;
  const shown = d.actions.filter((x) => folder || !x.id.startsWith("host_"));
  return (
    <div className="agp-access">
      {shown.map((x) => (
        <div key={x.id} className={"acc-row dec-" + d.rules[x.id]}>
          <span className="l">{x.label}</span>
          <span className="v">{DECISION_TEXT[d.rules[x.id]]}</span>
        </div>
      ))}
      <div className="acc-row">
        <span className="l">Pasta do seu computador</span>
        <span className="v" title={folder || ""}>{folder ? folderName(folder) : "nenhuma"}</span>
      </div>
      <div className="acc-row">
        <span className="l">Pesquisa proativa</span>
        <span className="v">{d.agent.research_hours ? `a cada ${d.agent.research_hours} h` : "desligada"}</span>
      </div>
      <button type="button" className="btn ghost agp-edit" onClick={() => editAgent(d.agent.id)}>
        <Ic name="sliders" />
        Editar permissões
      </button>
    </div>
  );
}

const GROUPS: { id: TaskGroup; label: string }[] = [
  { id: "active", label: "Em andamento" },
  { id: "scheduled", label: "Agendadas" },
  { id: "done", label: "Concluídas" },
];

const STATUS_ORDER: Partial<Record<AgentTask["status"], number>> = { running: 0, waiting: 1, blocked: 2 };

function sortGroup(id: TaskGroup, tasks: AgentTask[]) {
  if (id === "done") return [...tasks].sort((a, b) => b.updated_at - a.updated_at);
  const rank = (t: AgentTask) => STATUS_ORDER[t.status] ?? 3;
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (a.next_run_at ?? Infinity) - (b.next_run_at ?? Infinity));
}

/** The agent's work, by where it stands: in progress, scheduled, done (done starts folded). */
function WorkGroup({ label, tasks, folded }: { label: string; tasks: AgentTask[]; folded?: boolean }) {
  const [open, setOpen] = useState(!folded);
  if (!tasks.length) return null;
  return (
    <div className="work-group">
      <button type="button" className="work-group-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} />
        <span>{label}</span>
        <span className="n">{tasks.length}</span>
      </button>
      {open && tasks.map((t) => <TaskRow key={t.id} t={t} />)}
    </div>
  );
}

const EVENT_TEXT: Record<AgentEvent["kind"], string> = {
  created: "criada",
  ran: "rodou",
  continue: "vai continuar",
  blocked: "precisa de você",
  done: "concluída",
  error: "falhou",
  stopped: "interrompida",
  resumed: "retomada",
};

/** The journal: what the agent's work did, newest first. */
function ActivityList({ events, tasks }: { events: AgentEvent[]; tasks: AgentTask[] }) {
  if (!events.length) return <p className="agp-empty">O que o trabalho do agente fizer aparece aqui: execuções, conclusões, perguntas.</p>;
  return (
    <ol className="agp-log">
      {events.map((e) => {
        const task = tasks.find((t) => t.id === e.task_id);
        return (
          <li key={e.id} className={"ev-" + e.kind}>
            <button type="button" disabled={!task} onClick={() => task && openConversation(task.conversation_id)}>
              <span className="h">
                <b>{e.title}</b> {EVENT_TEXT[e.kind] || e.kind} · {relTime(e.created_at)}
              </span>
              {e.text && <span className="x">{oneLine(e.text, 160)}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function AgentPanel() {
  const d = useApp((s) => s.agentDetail);
  const conv = useApp((s) => s.current?.conv);
  const [addingTask, setAddingTask] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  if (!d || d.agent.id !== conv?.agent_id) return <aside className="agent-panel is-loading" aria-hidden="true" />;
  const { agent, tasks, notes, approvals, activity = [] } = d;
  const blocked = tasks.filter((t) => t.status === "blocked");
  const waiting = approvals.length + blocked.length;
  const status = agent.paused ? "Pausado: nada roda sozinho" : agent.running ? (agent.running === 1 ? "1 trabalho rodando" : `${agent.running} trabalhos rodando`) : "Disponível";
  return (
    <aside className="agent-panel" aria-label={`Atividade de ${agent.name}`}>
      <header className="agp-head">
        <span className={cx("agent-glyph big", agent.running > 0 && "is-running", agent.paused && "is-paused")} aria-hidden="true">
          <i />
        </span>
        <div className="agp-id">
          <b>{agent.name}</b>
          <span>{status}</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Opções do agente" onClick={(e) => openMenu({ anchor: e.currentTarget, placement: "bottom-end", items: agentMenuItems(agent) })}>
          <Icon name="more" />
        </button>
      </header>
      {conv?.kind === "agent_task" && (
        <button type="button" className="agp-back" onClick={() => openAgent(agent)}>
          <Icon name="chevron-left" />
          Conversa principal
        </button>
      )}
      <div className="agp-scroll">
        {waiting > 0 && (
          <Section title="Esperando você" count={waiting}>
            {approvals.map((a) => (
              <ApprovalRow key={a.id} a={a} agent={agent} />
            ))}
            {blocked.map((t) => (
              <BlockedRow key={t.id} t={t} />
            ))}
          </Section>
        )}
        <Section
          title="Trabalho"
          action={
            <button type="button" className="icon-btn" aria-label="Nova tarefa" data-tip="Nova tarefa" onClick={() => setAddingTask(true)}>
              <Icon name="new" />
            </button>
          }
        >
          {addingTask && <TaskForm agentId={agent.id} onDone={() => setAddingTask(false)} />}
          {GROUPS.map((g) => (
            <WorkGroup key={g.id} label={g.label} folded={g.id === "done"} tasks={sortGroup(g.id, tasks.filter((t) => taskGroup(t) === g.id))} />
          ))}
          {!tasks.length && !addingTask && (
            <p className="agp-empty">Peça na conversa ou crie aqui. Um trabalho segue em segundo plano, guarda onde parou e continua até concluir; a agenda é opcional.</p>
          )}
        </Section>
        <Section title="Atividade" collapsed>
          <ActivityList events={activity} tasks={tasks} />
        </Section>
        <Section
          title="Notas"
          count={notes.length}
          action={
            <button type="button" className="icon-btn" aria-label="Nova nota" data-tip="Nova nota" onClick={() => setAddingNote(true)}>
              <Icon name="new" />
            </button>
          }
        >
          {addingNote && <NoteAdd agentId={agent.id} onDone={() => setAddingNote(false)} />}
          {[...notes].reverse().map((n) => (
            <NoteRow key={n.id} n={n} />
          ))}
          {!notes.length && !addingNote && <p className="agp-empty">A memória do agente. Ele anota o que vai importar depois; você pode editar tudo.</p>}
        </Section>
        <Section title="Acesso">
          <AccessSummary d={d} />
        </Section>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ thread intro

/** Until the suggestion model writes the agent's own cards. */
const SUGGESTIONS = [
  "Apresente-se e me pergunte sobre meus objetivos.",
  "O que você consegue fazer por mim?",
  "Todo dia às 8h, pesquise as principais notícias de IA e me traga um resumo.",
];

export function AgentIntro() {
  const conv = useApp((s) => s.current?.conv);
  const own = useApp((s) => s.agents.find((a) => a.id === s.current?.conv.agent?.id)?.suggestions);
  if (!conv?.agent) return null;
  const sugs = own?.length ? own : SUGGESTIONS;
  return (
    <div className="agent-intro">
      <span className="agent-glyph huge" aria-hidden="true">
        <i />
      </span>
      <b>{conv.agent.name}</b>
      <p>Tem memória própria, um computador isolado e um trabalho que segue sem você: cada tarefa guarda onde parou e continua até concluir. O que precisar da sua decisão aparece no painel ao lado.</p>
      <div className="intro-sugs">
        {sugs.map((s) => (
          <button
            key={s}
            type="button"
            className="intro-sug"
            onClick={() => {
              setText(s);
              focusComposer();
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ create / edit dialog

const RESEARCH_OPTIONS = [
  { v: 0, l: "Desligada" },
  { v: 1, l: "A cada hora" },
  { v: 3, l: "A cada 3 horas" },
  { v: 6, l: "A cada 6 horas" },
  { v: 12, l: "A cada 12 horas" },
  { v: 24, l: "Uma vez por dia" },
];

const DECISIONS: { id: AgentDecision; label: string }[] = [
  { id: "allow", label: "Livre" },
  { id: "ask", label: "Perguntar" },
  { id: "block", label: "Bloquear" },
];

const ACTION_HINTS: Record<AgentAction, string> = {
  web: "web_search e fetch_url",
  computer: "código e arquivos no Linux isolado do agente",
  tasks: "trabalho em segundo plano, inclusive recorrente",
  host_read: "ler e buscar na pasta concedida",
  host_edit: "alterar arquivos da pasta concedida",
  host_command: "comandos no Windows, sem sandbox",
  host_git_read: "status, diff, log e consulta da conta/repositório",
  host_git_write: "init, add, commit, branches, tags e remotes locais",
  host_github_publish: "criar repositório, push, release e anexos",
};

const ACTION_DEFAULTS: Record<AgentAction, AgentDecision> = {
  web: "allow", computer: "allow", tasks: "ask", host_read: "allow", host_edit: "ask", host_command: "ask",
  host_git_read: "allow", host_git_write: "ask", host_github_publish: "ask",
};
const ACTION_LABELS: Record<AgentAction, string> = {
  web: "Pesquisar e abrir páginas na web",
  computer: "Rodar código e gravar arquivos no computador dele",
  tasks: "Criar e agendar tarefas",
  host_read: "Ler a pasta concedida",
  host_edit: "Editar arquivos da pasta concedida",
  host_command: "Rodar comandos no PowerShell",
  host_git_read: "Consultar Git e GitHub",
  host_git_write: "Alterar o Git local",
  host_github_publish: "Publicar no GitHub",
};

export function AgentDialog({ id, agentId }: { id: number; agentId: string | null }) {
  const providers = useApp((s) => s.providers);
  const defaultModel = useApp((s) => s.settings.default_model);
  const [loaded, setLoaded] = useState(!agentId);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState<string | null>(defaultModel);
  const [folder, setFolder] = useState<string | null>(null);
  const [research, setResearch] = useState(0);
  const [rules, setRules] = useState<Record<AgentAction, AgentDecision>>({ ...ACTION_DEFAULTS });
  const [busy, setBusy] = useState(false);
  const models = allModels(providers);

  useEffect(() => {
    if (!agentId) return;
    api
      .agent(agentId)
      .then((d) => {
        setName(d.agent.name);
        setInstructions(d.agent.instructions);
        setModel(d.agent.model);
        setFolder(d.agent.host_folder);
        setResearch(d.agent.research_hours);
        setRules(d.rules);
        setLoaded(true);
      })
      .catch((e) => {
        toast(e.message);
        closeDialog(id);
      });
  }, [agentId, id]);

  const close = () => closeDialog(id);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await saveAgent(agentId, { name, instructions, model, host_folder: folder, research_hours: research, rules });
      close();
      if (!agentId) toast(`${name.trim()} está pronto`);
    } catch (err: any) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    try {
      const { path } = await api.pickProject();
      if (path) setFolder(path);
    } catch (err: any) {
      toast(err.message);
    }
  };
  const actions = (Object.keys(ACTION_LABELS) as AgentAction[]).filter((a) => folder || !a.startsWith("host_"));

  return (
    <DialogShell id={id} className="agent-dialog" label={agentId ? "Editar agente" : "Novo agente"}>
      <form onSubmit={submit} className={cx("agent-form", !loaded && "is-loading")}>
        <h3>{agentId ? "Editar agente" : "Novo agente"}</h3>
        <p className="lead">Um agente guarda o que aprende em notas, tem um computador próprio (Linux isolado) e leva trabalhos adiante em segundo plano, retomando de onde parou, enquanto o CEU estiver aberto.</p>
        <label className="af-field">
          <span>Nome</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ex.: Pesquisador, Operações, Atlas" />
        </label>
        <label className="af-field">
          <span>Papel e objetivos</span>
          <textarea
            className="textarea"
            rows={5}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="O que ele acompanha, como você gosta do trabalho feito, o que nunca deve fazer."
          />
        </label>
        <div className="af-grid">
          <label className="af-field">
            <span>Modelo</span>
            <select className="select" value={model || ""} onChange={(e) => setModel(e.target.value || null)}>
              {!models.some((m) => m.ref === model) && <option value={model || ""}>{model ? model.split("::").pop() : "Escolha um modelo"}</option>}
              {models.map((m) => (
                <option key={m.ref} value={m.ref}>
                  {m.name} · {m.provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="af-field">
            <span>Pesquisa proativa</span>
            <select className="select" value={research} onChange={(e) => setResearch(+e.target.value)}>
              {RESEARCH_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="af-field">
          <span>Pasta do seu computador (opcional)</span>
          <div className="af-folder">
            <code title={folder || ""}>{folder || "Nenhuma: o agente só usa o computador dele"}</code>
            <button type="button" className="btn" onClick={pick}>
              Escolher…
            </button>
            {folder && (
              <button type="button" className="btn ghost" onClick={() => setFolder(null)}>
                Remover
              </button>
            )}
          </div>
        </div>
        <div className="af-field">
          <span>Permissões</span>
          <div className="af-rules">
            {actions.map((a) => (
              <div key={a} className="af-rule">
                <div className="l">
                  <b>{ACTION_LABELS[a]}</b>
                  <span>{ACTION_HINTS[a]}</span>
                </div>
                <div className="seg" role="radiogroup" aria-label={ACTION_LABELS[a]}>
                  {DECISIONS.map((dd) => (
                    <button
                      key={dd.id}
                      type="button"
                      role="radio"
                      aria-checked={rules[a] === dd.id}
                      className={cx(rules[a] === dd.id && "is-on")}
                      onClick={() => setRules({ ...rules, [a]: dd.id })}
                    >
                      {dd.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="af-note">“Perguntar” pausa o trabalho até você responder, no painel do agente ou na conversa. A pesquisa proativa só lê e anota, qualquer que seja a regra.</p>
        </div>
        <div className="row">
          <button type="button" className="btn ghost" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim() || !model}>
            {agentId ? "Salvar" : "Criar agente"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
