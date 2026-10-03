// CEU Agent: client actions for agents, their tasks, notes and parked approvals
// (server side in server/agent_mode.py; design in docs/referencias-agent.md).
import { api, type Agent, type AgentFields, type AgentNote, type AgentTask, type Conversation, type Schedule, type ServerEvent } from "../api";
import { debounce } from "../lib/util";
import { newChat, openConversation, reloadCurrent } from "./actions";
import { focusComposer } from "./composer";
import { S, setS } from "./store";
import { confirmDialog, openDialog, toast } from "./ui";

// ------------------------------------------------------------------ labels

export const TASK_STATUS: Record<AgentTask["status"], string> = {
  idle: "Aguardando",
  running: "Rodando",
  waiting: "Espera você",
  blocked: "Precisa de você",
  done: "Concluída",
  error: "Falhou",
  stopped: "Interrompida",
  paused: "Pausada",
};

export function describeSchedule(s: Schedule) {
  if (!s) return "Sem agenda";
  if ("every_minutes" in s) {
    const n = s.every_minutes;
    if (n % 1440 === 0) return n === 1440 ? "Todo dia" : `A cada ${n / 1440} dias`;
    if (n % 60 === 0) return n === 60 ? "A cada hora" : `A cada ${n / 60} h`;
    return `A cada ${n} min`;
  }
  return `Todo dia às ${s.daily_at}`;
}

/** Where a task sits in the agent's work (mirrors agent_mode.group_of). */
export type TaskGroup = "active" | "scheduled" | "done";
export function taskGroup(t: AgentTask): TaskGroup {
  if (t.status === "done") return "done";
  if (t.status === "running" || t.status === "waiting" || t.status === "blocked" || !t.schedule) return "active";
  return "scheduled";
}

export const isAgentConv = (c: Conversation | null | undefined) => c?.kind === "agent" || c?.kind === "agent_task";

// ------------------------------------------------------------------ loading

export async function refreshAgents() {
  try {
    setS({ agents: await api.agents() });
  } catch {
    /* server unreachable: keep the last list */
  }
}
export const refreshAgentsSoon = debounce(refreshAgents, 200);

let detailTicket = 0;
/** Activity panel data for the agent whose thread is open. */
export async function loadAgentDetail(id = S().current?.conv.agent_id) {
  const ticket = ++detailTicket;
  if (!id) {
    if (S().agentDetail) setS({ agentDetail: null });
    return;
  }
  try {
    const d = await api.agent(id);
    if (ticket === detailTicket && S().current?.conv.agent_id === id) setS({ agentDetail: d });
  } catch (e: any) {
    if (ticket === detailTicket && e.status === 404) setS({ agentDetail: null });
  }
}
const loadAgentDetailSoon = debounce(() => loadAgentDetail(), 150);

export function onAgentEvent(ev: ServerEvent) {
  refreshAgentsSoon();
  const cur = S().current?.conv;
  if (!cur?.agent_id) return;
  if (ev.type === "agent" ? ev.agent_id === cur.agent_id : ev.type === "generation") loadAgentDetailSoon();
}

// ------------------------------------------------------------------ agents

export const openAgent = (a: Pick<Agent, "conversation_id">) => openConversation(a.conversation_id);
export const newAgent = () => openDialog({ kind: "agent", agentId: null });
export const editAgent = (id: string) => openDialog({ kind: "agent", agentId: id });

export async function saveAgent(id: string | null, fields: AgentFields) {
  const a = id ? await api.updateAgent(id, fields) : await api.createAgent(fields);
  await refreshAgents();
  if (!id) await openConversation(a.conversation_id);
  else {
    loadAgentDetail();
    if (S().current?.conv.id === a.conversation_id && fields.name) setS((s) => ({ current: s.current && { ...s.current, conv: { ...s.current.conv, title: a.name } } }));
  }
  return a;
}

export async function setAgentPaused(a: Agent, paused: boolean) {
  try {
    await api.updateAgent(a.id, { paused });
    toast(paused ? `${a.name} pausado: nada roda sozinho até você retomar` : `${a.name} retomado`);
  } catch (e: any) {
    toast(e.message);
  }
  refreshAgents();
  loadAgentDetail();
}

export async function removeAgent(a: Agent) {
  const ok = await confirmDialog({
    title: `Excluir ${a.name}?`,
    body: "A conversa, as tarefas e as notas do agente são apagadas. Os arquivos que ele criou na pasta concedida continuam lá.",
    confirm: "Excluir",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteAgent(a.id);
  } catch (e: any) {
    toast(e.message);
    return;
  }
  if (S().current?.conv.agent_id === a.id) newChat();
  refreshAgents();
  toast("Agente excluído");
}

// ------------------------------------------------------------------ tasks

export async function createTask(agentId: string, body: { title: string; instructions: string; schedule: Schedule; start_now: boolean }) {
  const t = await api.createTask(agentId, body);
  loadAgentDetail();
  return t;
}

export async function runTask(t: AgentTask) {
  try {
    await api.runTask(t.id);
    toast(`“${t.title}” começou`);
  } catch (e: any) {
    toast(e.message);
  }
  loadAgentDetail();
}

export async function markTaskDone(t: AgentTask) {
  try {
    await api.updateTask(t.id, { done: true });
    toast(`“${t.title}” concluída`);
  } catch (e: any) {
    toast(e.message);
  }
  loadAgentDetail();
}

/** A task blocked on a question: open its thread with the composer ready for the answer. */
export async function replyToTask(t: AgentTask) {
  await openConversation(t.conversation_id);
  focusComposer();
}

export async function setTaskPaused(t: AgentTask, paused: boolean) {
  try {
    await api.updateTask(t.id, { paused });
  } catch (e: any) {
    toast(e.message);
  }
  loadAgentDetail();
}

export async function removeTask(t: AgentTask) {
  const ok = await confirmDialog({
    title: `Excluir a tarefa “${t.title}”?`,
    body: "A tarefa para de rodar e a conversa dela é apagada.",
    confirm: "Excluir",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteTask(t.id);
  } catch (e: any) {
    toast(e.message);
    return;
  }
  if (S().current?.conv.id === t.conversation_id) {
    const a = S().agents.find((x) => x.id === t.agent_id);
    if (a) openAgent(a);
    else newChat();
  }
  loadAgentDetail();
}

// ------------------------------------------------------------------ notes

export async function addNote(agentId: string, content: string) {
  try {
    await api.createNote(agentId, content);
  } catch (e: any) {
    toast(e.message);
  }
  loadAgentDetail();
}

export async function editNote(n: AgentNote, content: string) {
  try {
    await api.updateNote(n.id, content);
  } catch (e: any) {
    toast(e.message);
  }
  loadAgentDetail();
}

export async function removeNote(n: AgentNote) {
  try {
    await api.deleteNote(n.id);
  } catch (e: any) {
    toast(e.message);
  }
  loadAgentDetail();
}

// ------------------------------------------------------------------ approvals

/** Answers a parked approval; the server resumes the turn on the same message. */
export async function answerParked(approvalId: string, conversationId: string, decision: "allow" | "always" | "deny", reason = "") {
  try {
    await api.answerAgentApproval(approvalId, { decision, reason });
  } catch (e: any) {
    toast(e.message);
  }
  if (S().current?.conv.id === conversationId) await reloadCurrent();
  loadAgentDetail();
  refreshAgentsSoon();
}
