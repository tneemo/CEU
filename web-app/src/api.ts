// Client for CEU's Python backend (server/main.py). Same API surface as
// the original vanilla-JS frontend (web/js/api.js).

// Browsers use the same origin (Python server or Vite proxy), including custom
// ports. Only the Tauri webview needs a direct connection to the local backend.
export const BASE = "__TAURI_INTERNALS__" in window ? "http://127.0.0.1:4747" : "";

export const apiUrl = (path: string) => BASE + path;

export interface Model {
  id: string;
  name: string;
  custom?: boolean;
}

export interface Provider {
  id: string;
  kind: "anthropic" | "openai" | "codex";
  preset: string;
  name: string;
  base_url: string;
  has_key?: boolean;
  key_hint?: string;
  enabled: boolean;
  models: Model[];
  created_at: string;
}

export interface EffortInfo {
  levels: string[];
  default: string;
}

export type Level = "more" | "default" | "less";

export interface Settings {
  // geral
  language: "auto" | "pt-BR" | "en";
  send_key: "enter" | "ctrl-enter";
  default_model: string | null;
  title_model: string | null;
  suggestion_model: string | null;
  temporary_default: boolean;
  // aparência
  theme: "system" | "dark" | "light";
  accent: "default" | "blue" | "green" | "yellow" | "pink" | "orange" | "purple" | "white";
  chat_font: "sans" | "serif" | "mono" | "system";
  font_size: number;
  code_font_size: number;
  width: "narrow" | "medium" | "wide";
  motion: "system" | "reduce" | "full";
  ambient: boolean;
  // personalização
  instructions: string;
  nickname: string;
  occupation: string;
  about: string;
  style: "default" | "professional" | "friendly" | "candid" | "quirky" | "efficient" | "cynical";
  warmth: Level;
  enthusiasm: Level;
  headers_lists: Level;
  emoji: Level;
  // memória
  memory_enabled: boolean;
  memory_chat_history: boolean;
  // notificações
  notify_done: boolean;
  notify_sound: boolean;
  // voz
  voice_name: string;
  voice_rate: number;
  // recursos
  tool_code: boolean;
  tool_files: boolean;
  sandbox_network: boolean;
  // lista de conversas
  sidebar_sort: "updated" | "created";
  sidebar_group: "date" | "none" | "project";
}

export interface Memory {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface UsageReport {
  totals: { conversations: number; prompts: number; responses: number; input_tokens: number; output_tokens: number };
  by_model: { model: string; responses: number; input: number; output: number }[];
  by_day: { day: string; responses: number; output: number }[];
  days: number;
}

export interface StorageReport {
  database: number;
  attachments: { count: number; bytes: number };
  workspaces: { count: number; bytes: number };
  archived: number;
}

export interface StateResponse {
  providers: Provider[];
  settings: Settings;
  presets: Record<string, { kind: string; name: string; base_url: string }>;
  efforts: Record<string, EffortInfo>;
  runtimes: RuntimeInfo[];
  integrations: Integration[];
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  source?: string;
}

export interface Usage {
  input?: number;
  output?: number;
  tps?: number;
  ttft_ms?: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  reasoning: string;
  reasoning_ms: number | null;
  /** waiting: an agent turn parked on an approval (resumes when the user answers) */
  status: "complete" | "streaming" | "error" | "stopped" | "waiting";
  error?: string | null;
  notice?: string | null;
  model?: string | null;
  model_run?: { requested_model: string | null; actual_model: string | null; requested_effort: string | null } | null;
  attachments: Attachment[];
  usage?: Usage | null;
  feedback?: 1 | -1 | null;
  created_at: number;
  finished_at?: number | null;
  /** code sessions: tool_call rows carry the calls, tool_result rows their results */
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
  /** code sessions: this turn's file edits can still be restored */
  undoable?: boolean;
  /** a turn asked of a named model (`@modelo`): on the user message that asked and on the reply */
  call?: CallSpec | null;
}

/** A call (server/calls.py): who answers this turn.
 * - `chat`: a model answers inline (target = model ref); a Room's turns also carry `room`.
 * - `code` / `agent`: delegated — the work runs in a Code session (target = folder) or an agent task
 *   (target = agent id) and the result comes back as the reply, which then records where it ran. */
export type CallSpec =
  | { surface: "chat"; target: string; effort?: string | null; room?: RoomTurn }
  | ({ surface: "code"; target: string; model?: string; effort?: string | null; mode?: PermissionMode | null } & CallLink)
  | ({ surface: "agent"; target: string } & CallLink);

/** Where a delegated call ran (set on the reply once the target started). */
export interface CallLink {
  conversation_id?: string;
  message_id?: string;
}

/** A Room turn's place in the sequence (server/rooms.py). */
export interface RoomTurn {
  round: number;
  rounds: number;
  turn: number;
  of: number;
  finale: boolean;
}

/** A Room: participants (model refs) in speaking order, rounds, closing speakers. */
export interface RoomConfig {
  order: string[];
  rounds: number;
  finale: string[];
  /** participants may use the Chat tools (code, files); off by default */
  tools: boolean;
  template?: string | null;
}

/** A ready-made Room; slots no model of the user's matched come back null. */
export interface RoomTemplate {
  id: string;
  name: string;
  description: string;
  order: (string | null)[];
  rounds: number;
  finale: (string | null)[];
  slots: { order: string[]; finale: string[] };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  is_error: boolean;
  meta: {
    path?: string;
    diff?: string;
    added?: number;
    removed?: number;
    created?: boolean;
    command?: string;
    exit_code?: number | null;
    ms?: number;
    timed_out?: boolean;
    output?: string;
    count?: number;
    files?: number;
    lines?: number;
    total?: number;
    denied?: boolean;
    reason?: string;
    cancelled?: boolean;
    steer?: string[];
    url?: string;
    title?: string;
    note_id?: string;
    task_id?: string;
    commit_sha?: string;
    branch?: string | null;
    tag?: string;
    remote?: string;
    remote_url?: string;
    repo_url?: string;
    release_url?: string;
    repository?: Record<string, unknown>;
    release?: Record<string, unknown>;
    artifacts_published?: Record<string, unknown>[];
    /** delegate (server/coordination.py): the executor call, where it ran, its verdict and the issues it raised */
    call?: string;
    conversation_id?: string;
    message_id?: string;
    role?: string;
    executor?: string;
    verdict?: "approved" | "changes" | null;
    issues?: string[];
    [key: string]: unknown;
  };
}

export type PermissionMode = "manual" | "accept_edits" | "plan" | "auto";

export interface ApprovalRequest {
  call_id: string;
  name: string;
  input: Record<string, any>;
  kind: "edit" | "command" | "git_write" | "github_publish" | "agent" | "unknown";
  rule: { tool: string; pattern: string };
  /** external harnesses: what "always" means there (e.g. "for this Codex session"); null hides it */
  always_label?: string | null;
  preview?: { path?: string; diff?: string; added?: number; removed?: number };
  /** agent approvals: the parked approval to answer, and what the card says */
  approval_id?: string;
  action?: AgentAction;
  action_label?: string;
  summary?: string;
  agent?: string;
  /** an executor's card forwarded to the agent's `delegate` call (server/coordination.py) */
  executor?: string;
  executor_call_id?: string;
}

// ------------------------------------------------------------------ agents

export type AgentAction = "web" | "computer" | "tasks" | "host_read" | "host_edit" | "host_command" | "host_git_read" | "host_git_write" | "host_github_publish" | "delegate";
export type AgentDecision = "allow" | "ask" | "block";
export type Schedule = { every_minutes: number } | { daily_at: string } | null;

export interface Agent {
  id: string;
  name: string;
  instructions: string;
  model: string | null;
  effort: string | null;
  conversation_id: string;
  host_folder: string | null;
  rules: Partial<Record<AgentAction, AgentDecision>>;
  research_hours: number;
  paused: boolean;
  /** starter cards written by the suggestion model (empty until it answers) */
  suggestions: string[];
  created_at: number;
  updated_at: number;
  /** approvals waiting + tasks blocked on a question */
  pending: number;
  blocked: number;
  running: number;
  task_count: number;
}

export interface AgentTask {
  id: string;
  agent_id: string;
  conversation_id: string;
  kind: "task" | "research";
  title: string;
  instructions: string;
  schedule: Schedule;
  status: "idle" | "running" | "waiting" | "blocked" | "done" | "error" | "stopped" | "paused";
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: string | null;
  runs: number;
  /** the agent's own record of where the work stands (update_task) */
  progress: string | null;
  /** how the current/last run ends: the agent's decision */
  outcome: { state: "continue" | "done" | "blocked"; question?: string; at?: number; why?: string } | null;
  /** continuations in a row without the user stepping in */
  streak: number;
  updated_at: number;
  active?: boolean;
}

/** One entry of the agent's activity journal (server/db.py agent_log). */
export interface AgentEvent {
  id: string;
  task_id: string | null;
  title: string;
  kind: "created" | "ran" | "continue" | "blocked" | "done" | "error" | "stopped" | "resumed";
  text: string;
  created_at: number;
}

export interface AgentNote {
  id: string;
  agent_id: string;
  content: string;
  source: "agent" | "user" | "research";
  created_at: number;
  updated_at: number;
}

export interface AgentApproval {
  id: string;
  conversation_id: string;
  message_id: string;
  request: ApprovalRequest;
  created_at: number;
  where: string;
  /** executor: a card an executor's turn is blocked on (answered on its message, not parked) */
  kind?: "executor";
}

/** Something an objective is unsure about or has to deal with (server/coordination.py). */
export interface AgentIssue {
  id: string;
  agent_id: string;
  task_id: string | null;
  kind: "problem" | "hypothesis" | "contradiction" | "question" | "lead" | "finding";
  title: string;
  detail: string;
  status: "open" | "noted" | "resolved" | "discarded";
  resolution: string | null;
  raised_by: string;
  call_id: string | null;
  closed_by: string | null;
  created_at: number;
  updated_at: number;
}

/** Work an agent asked of an executor: a Code session with another model or harness. */
export interface AgentCall {
  id: string;
  task_id: string | null;
  role: "investigate" | "implement" | "review";
  runtime: string;
  model: string | null;
  label: string;
  request: string;
  conversation_id: string | null;
  message_id: string | null;
  status: "running" | "complete" | "error" | "stopped";
  verdict: "approved" | "changes" | null;
  result: string;
  created_at: number;
  finished_at: number | null;
}

export interface AgentDetail {
  agent: Agent;
  tasks: AgentTask[];
  notes: AgentNote[];
  approvals: AgentApproval[];
  activity: AgentEvent[];
  actions: { id: AgentAction; label: string; default: AgentDecision }[];
  rules: Record<AgentAction, AgentDecision>;
  issues?: AgentIssue[];
  calls?: AgentCall[];
}

export type AgentFields = Partial<Pick<Agent, "name" | "instructions" | "model" | "effort" | "host_folder" | "rules" | "research_hours" | "paused">>;

export interface RecentProject {
  project_path: string;
  name: string;
  exists: boolean;
  used_at: number;
  sessions: number;
}

/** Harness that runs a code session (server/code_runtimes.py). */
export type RuntimeFamily = "ceu_sdk" | "codex_sdk" | "claude_sdk" | "redir";

export interface RuntimeInfo {
  id: string;
  family: RuntimeFamily;
  name: string;
  /** ready: can start sessions · unavailable: integrated, but its CLI/SDK is missing · planned: not integrated yet */
  status: "ready" | "unavailable" | "planned";
  detail: string;
  modes: PermissionMode[];
  default_mode: PermissionMode | null;
  mode_notes: Partial<Record<PermissionMode, string>>;
  /** provider kinds whose models it accepts; null = any (CEU's own loop) */
  model_kinds: string[] | null;
  /** Models and effort levels reported by this CLI, when it offers discovery. */
  models?: (Model & { effortLevels?: string[]; defaultEffort?: string })[];
  efforts?: string[];
  caps: { steer?: boolean; undo?: boolean; approvals?: boolean };
  /** the integration (install + login) this runtime depends on; null = none (CEU SDK) */
  integration: { id: string; state: IntegrationState; detail: string } | null;
}

/** Setup/auth lifecycle of an external harness (server/integrations.py). */
export type IntegrationState = "unconfigured" | "setup_required" | "authenticating" | "connected" | "error";
export type IntegrationAction = "install" | "login" | "cancel" | "logout" | "validate" | "refresh";

export interface LoginMethod {
  id: string;
  label: string;
  detail?: string;
  primary?: boolean;
  fields?: { id: string; label: string; secret?: boolean; options?: { id: string; label: string }[] }[];
}

export interface Integration {
  id: string;
  name: string;
  kind: "sdk" | "cli";
  vendor: string;
  /** runtime id it enables in the Code selector */
  runtime: string | null;
  /** integrations sharing install and login (Codex SDK + Codex CLI) */
  group: string;
  state: IntegrationState;
  detail: string;
  error: string | null;
  installed: boolean;
  path: string | null;
  version: string | null;
  requirements: { id: string; label: string; ok: boolean; detail: string }[];
  install_steps: { id: string; label: string; command: string; blocked: string | null }[];
  account: { email?: string; plan?: string; provider?: string; key_hint?: string; orgName?: string; subscriptionType?: string } | null;
  method: string | null;
  login_methods: LoginMethod[];
  auth_note: string;
  docs_url: string;
  can_logout: boolean;
  job: { kind: "install" | "login"; label: string; message: string; url: string | null; user_code: string | null; log: string[]; started: number } | null;
  /** what can be done now ("relogin" = log in again while connected) */
  actions: (IntegrationAction | "relogin")[];
  checked_at: number;
}

export interface GitHubStatus {
  connected: boolean;
  account: string | null;
  available: boolean;
  detail: string;
}

export interface Conversation {
  id: string;
  title: string;
  pinned: boolean | number;
  archived?: boolean;
  temporary?: boolean;
  model: string | null;
  effort: string | null;
  model_override?: string | null;
  effort_override?: string | null;
  current_leaf_id: string | null;
  created_at: number;
  updated_at: number;
  message_count?: number;
  streaming?: boolean;
  kind?: "chat" | "code" | "agent" | "agent_task";
  project_path?: string | null;
  permission_mode?: PermissionMode | null;
  /** code: runtime id (null = "ceu") */
  runtime?: string | null;
  project_exists?: boolean;
  git_branch?: string | null;
  /** agent threads */
  agent_id?: string | null;
  agent?: { id: string; name: string } | null;
  task?: Pick<AgentTask, "id" | "title" | "kind" | "status" | "schedule"> | null;
  pending_approval?: { id: string; message_id: string; request: ApprovalRequest } | null;
  /** a Code session / agent task started by a delegated call from a Chat conversation */
  /** where a delegated session came from; `role`/`agent_name`: an executor an agent called (server/coordination.py) */
  origin?: { conversation_id: string; message_id: string; title: string; role?: "investigate" | "implement" | "review"; agent_name?: string } | null;
  /** a Room (server/rooms.py) */
  room?: RoomConfig | null;
  room_running?: boolean;
}

export interface SearchResult {
  conversation_id: string;
  message_id: string;
  title: string;
  snippet: string;
  updated_at: number;
}

export type StreamEvent =
  | { type: "snapshot"; content: string; reasoning: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "reasoning_done"; ms: number }
  | { type: "reset" }
  | { type: "notice"; text: string }
  | { type: "tool_start"; call_id: string }
  | { type: "tool_output"; call_id: string; text: string }
  | { type: "tool_result"; result: ToolResult }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval_done"; call_id: string }
  | { type: "steer"; text: string }
  | { type: "delegate"; call: CallSpec; title: string }
  | { type: "done"; message: Message }
  | { type: "error"; message: string };

export interface ServerEvent {
  type: string;
  agent_id?: string | null;
  conversation_id?: string | null;
  message_id?: string;
  state?: string;
  deleted?: boolean;
}

export const EFFORT_LABELS: Record<string, string> = {
  none: "Nenhum",
  minimal: "Mínimo",
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  xhigh: "Extra",
  max: "Máx",
  ultra: "Ultra",
};

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Sem conexão com o servidor do CEU. Ele ainda está em execução?", 0);
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(data?.error || `Erro ${res.status}`, res.status);
  return data as T;
}

export const api = {
  state: () => req<StateResponse>("GET", "/api/state"),
  settings: (patch: Partial<Settings>) => req<Settings>("PUT", "/api/settings", patch),
  conversations: (archived = false) => req<Conversation[]>("GET", "/api/conversations" + (archived ? "?archived=1" : "")),
  conversation: (id: string) => req<{ conversation: Conversation; messages: Message[] }>("GET", `/api/conversations/${id}`),
  updateConversation: (
    id: string,
    patch: Partial<{ title: string; pinned: boolean; archived: boolean; current_leaf_id: string; model: string | null; effort: string | null; permission_mode: PermissionMode; room: RoomConfig }>,
  ) => req<Conversation>("PATCH", `/api/conversations/${id}`, patch),
  deleteConversation: (id: string) => req("DELETE", `/api/conversations/${id}`),
  restoreConversation: (id: string) => req<Conversation>("POST", `/api/conversations/${id}/restore`),
  deleteAll: () => req("DELETE", "/api/conversations"),
  search: (q: string) => req<SearchResult[]>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  chat: (body: {
    conversation_id: string | null;
    parent_id: string | null;
    content: string;
    attachments: Attachment[];
    model: string | null;
    effort: string | null;
    temporary?: boolean;
    kind?: "code";
    project_path?: string;
    permission_mode?: PermissionMode;
    runtime?: string;
    call?: CallSpec | null;
  }) => req<{ conversation: Conversation; user: Message; assistant: Message }>("POST", "/api/chat", body),
  approve: (messageId: string, body: { call_id: string; decision: "allow" | "always" | "deny"; reason?: string }) =>
    req("POST", `/api/messages/${messageId}/approval`, body),
  steer: (conversationId: string, text: string) => req("POST", `/api/conversations/${conversationId}/steer`, { text }),
  undo: (messageId: string) => req<{ restored: number }>("POST", `/api/messages/${messageId}/undo`),
  projects: () => req<RecentProject[]>("GET", "/api/projects"),
  pickProject: () => req<{ path: string | null }>("POST", "/api/projects/pick"),
  openProject: (path: string) => req("POST", "/api/projects/open", { path }),
  regenerate: (id: string, body: { model: string | null; effort: string | null }) =>
    req<{ conversation: Conversation; assistant: Message }>("POST", `/api/messages/${id}/regenerate`, body),
  edit: (id: string, body: { content: string; model: string | null; effort: string | null }) =>
    req<{ conversation: Conversation; user: Message; assistant: Message }>("POST", `/api/messages/${id}/edit`, body),
  stop: (id: string) => req("POST", `/api/messages/${id}/stop`),
  feedback: (id: string, feedback: 1 | -1 | null) => req<Message>("PATCH", `/api/messages/${id}`, { feedback }),
  branch: (id: string) => req<Conversation>("POST", `/api/messages/${id}/branch`),
  archiveAll: () => req("POST", "/api/archive"),
  deleteArchived: () => req("DELETE", "/api/archive"),
  memories: () => req<Memory[]>("GET", "/api/memories"),
  createMemory: (content: string) => req<Memory>("POST", "/api/memories", { content }),
  updateMemory: (id: string, content: string) => req<Memory>("PATCH", `/api/memories/${id}`, { content }),
  deleteMemory: (id: string) => req("DELETE", `/api/memories/${id}`),
  deleteAllMemories: () => req("DELETE", "/api/memories"),
  usage: () => req<UsageReport>("GET", "/api/usage"),
  storage: () => req<StorageReport>("GET", "/api/storage"),
  createProvider: (body: Record<string, unknown>) =>
    req<{ provider: Provider; error?: string }>("POST", "/api/providers", body),
  updateProvider: (id: string, patch: Record<string, unknown>) =>
    req<{ provider: Provider; error?: string }>("PATCH", `/api/providers/${id}`, patch),
  refreshProvider: (id: string) => req<{ provider: Provider; error?: string }>("POST", `/api/providers/${id}/refresh`),
  deleteProvider: (id: string) => req("DELETE", `/api/providers/${id}`),
  integrations: (refresh = false) =>
    req<{ integrations: Integration[]; runtimes: RuntimeInfo[] }>("GET", `/api/integrations${refresh ? "?refresh=1" : ""}`),
  integrationAction: (id: string, action: IntegrationAction, body?: { method?: string; params?: Record<string, string> }) =>
    req<{ integration: Integration }>("POST", `/api/integrations/${id}/${action}`, body || {}),
  github: () => req<{ github: GitHubStatus; git_installed: boolean }>("GET", "/api/github"),
  githubConnect: (token: string) => req<{ github: GitHubStatus }>("POST", "/api/github/connect", { token }),
  githubDisconnect: () => req<{ github: GitHubStatus }>("POST", "/api/github/disconnect", {}),
  githubValidate: () => req<{ github: GitHubStatus }>("POST", "/api/github/validate", {}),
  codexAccount: () => req<{ connected: boolean; email?: string; plan?: string; error?: string }>("GET", "/api/providers/codex/account"),
  codexLoginStart: () => req<{ loginId: string }>("POST", "/api/providers/codex/login/start"),
  codexLoginWait: (loginId: string) =>
    req<{ done: boolean; account?: { email?: string; plan?: string } }>("POST", "/api/providers/codex/login/wait", { loginId }),
  codexLoginCancel: (loginId: string) => req("POST", "/api/providers/codex/login/cancel", { loginId }),

  suggestions: () => req<{ items: string[] }>("GET", "/api/suggestions"),
  agents: () => req<Agent[]>("GET", "/api/agents"),
  roomTemplates: () => req<RoomTemplate[]>("GET", "/api/rooms/templates"),
  createRoom: (body: { title?: string; room: RoomConfig }) => req<Conversation>("POST", "/api/rooms", body),
  agent: (id: string) => req<AgentDetail>("GET", `/api/agents/${id}`),
  createAgent: (body: AgentFields) => req<Agent>("POST", "/api/agents", body),
  updateAgent: (id: string, patch: AgentFields) => req<Agent>("PATCH", `/api/agents/${id}`, patch),
  deleteAgent: (id: string) => req("DELETE", `/api/agents/${id}`),
  createNote: (agentId: string, content: string) => req<AgentNote>("POST", `/api/agents/${agentId}/notes`, { content }),
  updateNote: (id: string, content: string) => req<AgentNote>("PATCH", `/api/agent-notes/${id}`, { content }),
  deleteNote: (id: string) => req("DELETE", `/api/agent-notes/${id}`),
  createTask: (agentId: string, body: { title: string; instructions: string; schedule: Schedule; start_now: boolean }) =>
    req<AgentTask>("POST", `/api/agents/${agentId}/tasks`, body),
  updateTask: (id: string, patch: Partial<{ title: string; instructions: string; schedule: Schedule; paused: boolean; done: boolean }>) =>
    req<AgentTask>("PATCH", `/api/agent-tasks/${id}`, patch),
  runTask: (id: string) => req<AgentTask>("POST", `/api/agent-tasks/${id}/run`),
  deleteTask: (id: string) => req("DELETE", `/api/agent-tasks/${id}`),
  updateIssue: (id: string, body: { status: "open" | "resolved" | "discarded"; resolution?: string }) =>
    req<AgentIssue>("PATCH", `/api/issues/${id}`, body),
  answerAgentApproval: (id: string, body: { decision: "allow" | "always" | "deny"; reason?: string }) =>
    req<{ ok: boolean; conversation_id: string; message_id: string }>("POST", `/api/agent-approvals/${id}`, body),

  upload(file: File, onProgress?: (p: number) => void): Promise<Attachment> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", BASE + "/api/attachments");
      x.setRequestHeader("X-Filename", encodeURIComponent(file.name || "colado.png"));
      x.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => {
        let data: any = null;
        try {
          data = JSON.parse(x.responseText);
        } catch {
          /* ignore */
        }
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(new ApiError(data?.error || `Falha no envio (${x.status})`, x.status));
      };
      x.onerror = () => reject(new ApiError("Falha de rede ao enviar o arquivo.", 0));
      x.send(file);
    });
  },

  /** Attach to a generation. Returns a close() function. */
  stream(messageId: string, handlers: { event?: (ev: StreamEvent) => void; lost?: () => void }) {
    const es = new EventSource(`${BASE}/api/stream/${messageId}`);
    let finished = false;
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as StreamEvent;
      handlers.event?.(ev);
      if (ev.type === "done" || ev.type === "error") {
        finished = true;
        es.close();
      }
    };
    es.onerror = () => {
      if (finished) return;
      es.close();
      handlers.lost?.();
    };
    return () => {
      finished = true;
      es.close();
    };
  },

  /** Global server event bus, reconnecting with backoff. */
  events(onEvent: (ev: ServerEvent) => void) {
    let es: EventSource;
    let retry = 1000;
    const open = () => {
      es = new EventSource(`${BASE}/api/events`);
      es.onopen = () => {
        retry = 1000;
      };
      es.onmessage = (e) => onEvent(JSON.parse(e.data));
      es.onerror = () => {
        es.close();
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    open();
  },
};

/** ref = "providerId::modelId" — the composite id used throughout the app. */
export function effortFor(efforts: Record<string, EffortInfo>, ref: string | null | undefined) {
  if (!ref) return null;
  return efforts[ref] ?? null;
}

export function allModels(providers: Provider[]) {
  return providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ ref: `${p.id}::${m.id}`, id: m.id, name: m.name || m.id, provider: p })));
}

export type ModelEntry = ReturnType<typeof allModels>[number];
