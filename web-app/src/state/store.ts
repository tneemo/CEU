// Central client state (port of web/js/state.js) on a zustand store.
// Messages are replaced immutably so each React component re-renders only
// when its own message changes.
import { create } from "zustand";
import {
  allModels as modelsOf,
  type Agent,
  type AgentDetail,
  type ApprovalRequest,
  type Conversation,
  type PermissionMode,
  type ToolResult,
  type EffortInfo,
  type Message,
  type ModelEntry,
  type Provider,
  type Integration,
  type RuntimeInfo,
  type Settings,
} from "../api";
import { store } from "../lib/util";

export interface Current {
  conv: Conversation;
  msgs: Record<string, Message>;
}

export interface AppState {
  providers: Provider[];
  settings: Settings;
  presets: Record<string, { kind: string; name: string; base_url: string }>;
  efforts: Record<string, EffortInfo>;
  convs: Conversation[];
  current: Current | null;
  /** model/effort chosen while no conversation is open */
  pendingModel: string | null;
  pendingEffort: string | null;
  /** the next new conversation is temporary (not kept in history) */
  pendingTemporary: boolean;
  /** message id being read aloud */
  speakingId: string | null;
  /** message ids streaming in the open conversation */
  generating: string[];
  editingId: string | null;
  /** bumps each time a conversation is (re)opened, to replay the entering animation */
  openSeq: number;
  /** empty state: the next conversation is a code session in this folder */
  pendingKind: "chat" | "code";
  pendingProject: string | null;
  pendingMode: PermissionMode;
  /** code: every runtime the server knows (with its live state), and the one the next session uses */
  runtimes: RuntimeInfo[];
  pendingRuntime: string;
  /** setup/login state of the external harnesses behind the runtimes (settings hub) */
  integrations: Integration[];
  /** code sessions: live state of tool calls in the running round, by call id */
  toolLive: Record<string, ToolLive>;
  /** the tool call waiting for the user's decision */
  approval: { messageId: string; request: ApprovalRequest } | null;
  /** CEU Agent: every agent (sidebar), and the one whose thread is open (activity panel) */
  agents: Agent[];
  /** starter cards of the empty chat */
  homeSuggestions: string[];
  agentDetail: AgentDetail | null;
}

export interface ToolLive {
  running: boolean;
  output: string;
  result?: ToolResult;
}

export const useApp = create<AppState>(() => ({
  providers: [],
  settings: {
    language: "auto",
    send_key: "enter",
    default_model: null,
    title_model: null,
    suggestion_model: null,
    temporary_default: false,
    theme: "system",
    accent: "default",
    chat_font: "sans",
    font_size: 15,
    code_font_size: 13,
    width: "medium",
    motion: "system",
    ambient: true,
    instructions: "",
    nickname: "",
    occupation: "",
    about: "",
    style: "default",
    warmth: "default",
    enthusiasm: "default",
    headers_lists: "default",
    emoji: "default",
    memory_enabled: true,
    memory_chat_history: false,
    notify_done: false,
    notify_sound: false,
    voice_name: "",
    voice_rate: 1,
    tool_code: true,
    tool_files: true,
    sandbox_network: true,
    sidebar_sort: "updated",
    sidebar_group: "date",
  },
  presets: {},
  efforts: {},
  convs: [],
  current: null,
  pendingModel: null,
  pendingEffort: null,
  pendingTemporary: false,
  speakingId: null,
  generating: [],
  editingId: null,
  openSeq: 0,
  pendingKind: "chat",
  pendingProject: null,
  pendingMode: "manual",
  runtimes: [],
  pendingRuntime: store.get<string>("last_runtime", "ceu"),
  integrations: [],
  toolLive: {},
  approval: null,
  agents: [],
  homeSuggestions: [],
  agentDetail: null,
}));

export const S = () => useApp.getState();
export const setS = useApp.setState;

// ------------------------------------------------------------------ conversation tree

export function setCurrent(conv: Conversation, messages: Message[]) {
  const msgs: Record<string, Message> = {};
  for (const m of messages) msgs[m.id] = m;
  setS({ current: { conv, msgs }, editingId: null });
}

export function upsertMessage(m: Partial<Message> & { id: string }) {
  const cur = S().current;
  if (!cur) return;
  setS({ current: { ...cur, msgs: { ...cur.msgs, [m.id]: { ...(cur.msgs[m.id] || {}), ...m } as Message } } });
}

export function patchConv(patch: Partial<Conversation>) {
  const cur = S().current;
  if (!cur) return;
  setS({ current: { ...cur, conv: { ...cur.conv, ...patch } } });
}

const childCache = new WeakMap<Record<string, Message>, Map<string, Message[]>>();

/** parent id (or 'root') → children sorted by creation. Memoized per msgs object. */
export function childrenIndex(msgs: Record<string, Message>) {
  let idx = childCache.get(msgs);
  if (idx) return idx;
  idx = new Map();
  for (const m of Object.values(msgs)) {
    const k = m.parent_id || "root";
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k)!.push(m);
  }
  for (const list of idx.values()) list.sort((a, b) => a.created_at - b.created_at);
  childCache.set(msgs, idx);
  return idx;
}

/** Messages on the active branch, root → leaf. */
export function activePath(cur: Current | null): Message[] {
  if (!cur) return [];
  let leaf: Message | undefined = cur.conv.current_leaf_id ? cur.msgs[cur.conv.current_leaf_id] : undefined;
  if (!leaf) leaf = Object.values(cur.msgs).sort((a, b) => b.created_at - a.created_at)[0];
  const out: Message[] = [];
  const seen = new Set<string>();
  while (leaf && !seen.has(leaf.id)) {
    seen.add(leaf.id);
    out.push(leaf);
    leaf = leaf.parent_id ? cur.msgs[leaf.parent_id] : undefined;
  }
  return out.reverse();
}

export function siblings(cur: Current, m: Message) {
  return (childrenIndex(cur.msgs).get(m.parent_id || "root") || []).filter((x) => x.role === m.role);
}

/** Deepest most-recent descendant — where a branch "continues". */
export function latestLeaf(cur: Current, m: Message) {
  const idx = childrenIndex(cur.msgs);
  let node = m;
  for (;;) {
    const kids = idx.get(node.id);
    if (!kids?.length) return node;
    node = kids[kids.length - 1];
  }
}

// ------------------------------------------------------------------ areas and runtimes

/** Main destinations of the sidebar. Agent threads live under Chat. */
export type Area = "chat" | "code";

export function areaOf(st: AppState = S()): Area {
  if (st.current) return st.current.conv.kind === "code" ? "code" : "chat";
  return st.pendingKind;
}

/** CEU's own loop: what every session ran before runtimes existed (and the fallback). */
const CEU_RUNTIME: RuntimeInfo = {
  id: "ceu", family: "ceu_sdk", name: "CEU SDK", status: "ready", detail: "",
  modes: ["manual", "accept_edits", "plan", "auto"], default_mode: "manual", mode_notes: {}, model_kinds: null,
  caps: { steer: true, undo: true, approvals: true }, integration: null,
};

export function findRuntime(id: string | null | undefined, st: AppState = S()): RuntimeInfo {
  return st.runtimes.find((r) => r.id === (id || "ceu")) || CEU_RUNTIME;
}

/** Runtime of the open code session, or of the one about to start. */
export function currentRuntime(st: AppState = S()): RuntimeInfo {
  return findRuntime(st.current ? st.current.conv.runtime : st.pendingRuntime, st);
}

/** Providers whose models a runtime accepts (all of them for CEU's own loop). */
export function providersFor(rt: RuntimeInfo, providers: Provider[]) {
  if (rt.family === "redir") return [{
    id: rt.id, kind: "codex" as const, preset: "", name: rt.name, base_url: "", enabled: true,
    models: rt.models || [], created_at: "",
  }];
  return rt.model_kinds ? providers.filter((p) => rt.model_kinds!.includes(p.kind)) : providers;
}

// ------------------------------------------------------------------ models

const modelsCache = new WeakMap<Provider[], ModelEntry[]>();
export function allModels(providers = S().providers) {
  let list = modelsCache.get(providers);
  if (!list) {
    list = modelsOf(providers);
    modelsCache.set(providers, list);
  }
  return list;
}

export function findModel(ref: string | null | undefined, providers = S().providers) {
  if (!ref) return null;
  return allModels(providers).find((m) => m.ref === ref) || null;
}

export function prettyModel(ref: string | null | undefined, providers = S().providers) {
  const m = findModel(ref, providers);
  if (m) return m.name;
  if (!ref) return "Sem modelo";
  return ref.split("::").pop()!;
}

export function selectedModel(st: AppState = S()): string | null {
  const c = st.current?.conv;
  const ref = c?.model_override || c?.model || st.pendingModel || st.settings.default_model;
  if (findModel(ref, st.providers)) return ref!;
  const fallback = findModel(st.settings.default_model, st.providers) ? st.settings.default_model : allModels(st.providers)[0]?.ref;
  return fallback || ref || null;
}

/** Model for the open (or next) session under its runtime. An external harness gets a model only
 * when it belongs to a provider kind it understands; null means "the CLI's own default". */
export function runtimeModel(st: AppState = S()): string | null {
  const rt = st.current?.conv.kind === "code" || (!st.current && st.pendingKind === "code") ? currentRuntime(st) : null;
  if (rt?.family === "redir") {
    const ref = st.current ? (st.current.conv.model_override ?? st.current.conv.model) : st.pendingModel;
    if (ref?.startsWith(`${rt.id}::`)) return ref;
    const old = findModel(ref, st.providers);
    return st.current && old && rt.model_kinds?.includes(old.provider.kind) ? ref : null;
  }
  const ref = selectedModel(st);
  if (!rt?.model_kinds) return ref;
  const m = findModel(ref, st.providers);
  return m && rt.model_kinds.includes(m.provider.kind) ? ref : null;
}

export function selectedEffort(ref: string | null = selectedModel(), st: AppState = S()): string | null {
  const rt = st.current?.conv.kind === "code" || (!st.current && st.pendingKind === "code") ? currentRuntime(st) : null;
  if (rt?.family === "redir") {
    const e = st.current ? (st.current.conv.effort_override ?? st.current.conv.effort) : st.pendingEffort;
    const model = rt.models?.find((m) => `${rt.id}::${m.id}` === ref);
    const levels = model?.effortLevels || rt.efforts || [];
    return e && levels.includes(e) ? e : null;
  }
  const info = ref ? st.efforts[ref] : null;
  if (!info) return null;
  const e = st.current ? (st.current.conv.effort_override ?? st.current.conv.effort) : st.pendingEffort;
  return e && info.levels.includes(e) ? e : info.default;
}
