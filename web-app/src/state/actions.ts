// Controller: navigation, chat actions, streaming and server events
// (port of web/js/app.js + the streaming half of web/js/thread.js).
import { api, type Conversation, type IntegrationAction, type Message, type PermissionMode, type RoomConfig, type ServerEvent, type StreamEvent } from "../api";
import { debounce, download, isMobile, store } from "../lib/util";
import {
  S,
  activePath,
  allModels,
  areaOf,
  currentRuntime,
  findModel,
  findRuntime,
  latestLeaf,
  patchConv,
  runtimeModel,
  selectedEffort,
  selectedModel,
  setCurrent,
  setS,
  upsertMessage,
  type Area,
} from "./store";
import { answerParked, isAgentConv, loadAgentDetail, onAgentEvent } from "./agents";
import { clearComposer, currentDraftKey, focusComposer, loadDraft, outgoing, setText, useComposer } from "./composer";
import { closeMenu, openDialog, openSettings, toast } from "./ui";

// ------------------------------------------------------------------ view coordination
// Imperative hints consumed by components after their next render.

export type ScrollIntent = "bottom" | "anchor" | "keep" | { reveal: string } | { highlight: string };

export const view = {
  scrollIntent: null as ScrollIntent | null,
  /** dock top before leaving the empty state, for the FLIP transition */
  dockTopBefore: null as number | null,
  titleAnim: 0,
  openModelPicker: () => {},
};

// ------------------------------------------------------------------ appearance

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const themeListeners = new Set<() => void>();
export const onThemeChange = (fn: () => void) => {
  themeListeners.add(fn);
  return () => void themeListeners.delete(fn);
};

export function applyTheme() {
  const t = S().settings.theme || "system";
  const dark = t === "dark" || (t === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  store.raw("theme", t);
  themeListeners.forEach((fn) => fn());
}

/** Accent colours per theme: [dark, light]. "default" keeps the palette from theme.css. */
export const ACCENTS: Record<string, { label: string; dark: string; light: string }> = {
  default: { label: "Padrão", dark: "#a9c1ff", light: "#3656c4" },
  blue: { label: "Azul", dark: "#7cb8ff", light: "#1f6fd1" },
  green: { label: "Verde", dark: "#7fdcaa", light: "#1d8a57" },
  yellow: { label: "Amarelo", dark: "#f3d36b", light: "#a07800" },
  pink: { label: "Rosa", dark: "#f7a3cf", light: "#c2327f" },
  orange: { label: "Laranja", dark: "#ffb37a", light: "#c25a12" },
  purple: { label: "Roxo", dark: "#c3a6ff", light: "#6e43d6" },
  white: { label: "Branco", dark: "#e9ecf2", light: "#2a2f39" },
};

export const WIDTHS = { narrow: 640, medium: 760, wide: 940 } as const;

function hexAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function applyAppearance() {
  const s = S().settings;
  const root = document.documentElement;
  const dark = root.dataset.theme === "dark";
  const acc = s.accent && s.accent !== "default" ? ACCENTS[s.accent] : null;
  for (const [k, v] of Object.entries({
    "--accent": acc ? (dark ? acc.dark : acc.light) : "",
    "--accent-2": acc ? hexAlpha(dark ? acc.dark : acc.light, dark ? 0.14 : 0.09) : "",
    "--accent-3": acc ? hexAlpha(dark ? acc.dark : acc.light, dark ? 0.3 : 0.22) : "",
    "--fs-code": (s.code_font_size || 13) + "px",
    "--thread-w": (WIDTHS[s.width] || WIDTHS.medium) + "px",
  }))
    if (v) root.style.setProperty(k, v);
    else root.style.removeProperty(k);
  root.dataset.chatFont = s.chat_font || "sans";
  root.dataset.motion = s.motion || "system";
  store.raw(
    "appearance",
    JSON.stringify({ accent: s.accent, chatFont: root.dataset.chatFont, motion: root.dataset.motion, code: s.code_font_size, width: s.width }),
  );
}

export function applySettings() {
  applyTheme();
  const fs = S().settings.font_size || 15;
  document.documentElement.style.setProperty("--fs-body", fs + "px");
  store.raw("font", String(fs));
  applyAppearance();
}

onThemeChange(applyAppearance);

darkQuery.addEventListener("change", applyTheme);

export function setSidebar(open: boolean) {
  if (isMobile()) {
    document.documentElement.dataset.drawer = open ? "open" : "closed";
    return;
  }
  document.documentElement.dataset.sidebar = open ? "open" : "closed";
  store.raw("sidebar", open ? "open" : "closed");
}

export function toggleSidebar() {
  if (isMobile()) setSidebar(document.documentElement.dataset.drawer !== "open");
  else setSidebar(document.documentElement.dataset.sidebar === "closed");
}

export async function toggleTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  try {
    setS({ settings: await api.settings({ theme: dark ? "light" : "dark" }) });
    applySettings();
  } catch (e: any) {
    toast(e.message);
  }
}

// ------------------------------------------------------------------ data

export async function loadState() {
  const st = await api.state();
  setS({ providers: st.providers, settings: st.settings, presets: st.presets, efforts: st.efforts, runtimes: st.runtimes || [], integrations: st.integrations || [] });
}

/** Runtimes hub: setup/login state of the external harnesses, and the runtimes that depend on
 * them. `refresh` re-checks every integration on the server (slower: it runs the CLIs). */
export async function loadIntegrations(refresh = false) {
  try {
    const res = await api.integrations(refresh);
    setS({ integrations: res.integrations, runtimes: res.runtimes });
  } catch (e: any) {
    if (refresh) toast(e.message);
  }
}

const loadIntegrationsSoon = debounce(() => loadIntegrations(), 150);

/** Runs a hub action (install, login, cancel, logout, validate, refresh). Progress arrives as
 * "integrations" server events; the response already carries the new snapshot. */
export async function integrationAction(id: string, action: IntegrationAction, body?: { method?: string; params?: Record<string, string> }) {
  try {
    const { integration } = await api.integrationAction(id, action, body);
    setS((st) => ({ integrations: st.integrations.map((i) => (i.id === integration.id ? integration : i)) }));
    loadIntegrationsSoon();
    return integration;
  } catch (e: any) {
    toast(e.message, { duration: 6000 });
    loadIntegrationsSoon();
    return null;
  }
}

export async function refreshConvs() {
  let convs: Conversation[];
  try {
    convs = await api.conversations();
  } catch {
    return;
  }
  setS({ convs });
  const cur = S().current;
  if (cur) {
    const c = convs.find((x) => x.id === cur.conv.id);
    if (c && c.title !== cur.conv.title) {
      patchConv({ title: c.title });
      view.titleAnim++;
    }
  }
}
export const refreshConvsSoon = debounce(refreshConvs, 150);

// ------------------------------------------------------------------ navigation (hash routes: #/c/<id>, #/code)

let opening = 0;

function pushRoute(path: string) {
  const hash = path === "/" ? "" : "#" + path;
  if (location.hash !== hash) history.pushState({}, "", location.pathname + location.search + hash);
}

/** Leaving a temporary conversation discards it (Claude: modo incógnito, ChatGPT: chat temporário). */
function leaveTemporary(nextId?: string) {
  const conv = S().current?.conv;
  if (!conv?.temporary || conv.id === nextId) return;
  for (const id of S().generating) api.stop(id).catch(() => {});
  api.deleteConversation(conv.id).catch(() => {});
  store.del("draft:" + conv.id);
}

/** Empty state of an area: a new chat, or a new code session (by default, in the area the user is in). */
export function newChat({ push = true, temporary = S().settings.temporary_default, code = areaOf() === "code" } = {}) {
  leaveTemporary();
  detachAll();
  closeMenu();
  stopSpeaking();
  setS({
    current: null,
    editingId: null,
    agentDetail: null,
    pendingTemporary: !code && !!temporary,
    pendingKind: code ? "code" : "chat",
    ...(code ? { pendingModel: null, pendingEffort: null } : {}),
    pendingProject: code ? S().pendingProject || store.get<string | null>("last_project", null) : S().pendingProject,
  });
  if (code) fitPendingMode();
  if (push) pushRoute(code ? "/code" : "/");
  loadDraft();
  setSidebar(isMobile() ? false : document.documentElement.dataset.sidebar !== "closed");
  focusComposer();
}

export async function openConversation(id: string, { push = true, messageId = null as string | null } = {}) {
  if (S().current?.conv.id === id && !messageId) {
    if (isMobile()) setSidebar(false);
    return;
  }
  const ticket = ++opening;
  let data: { conversation: Conversation; messages: Message[] };
  try {
    data = await api.conversation(id);
  } catch (e: any) {
    toast(e.status === 404 ? "Esta conversa não existe mais." : e.message);
    if (!S().current) newChat({ push: false });
    return;
  }
  if (ticket !== opening) return; // a newer navigation won
  leaveTemporary(id);
  detachAll();
  stopSpeaking();
  closeMenu();
  const conv = data.conversation;
  setCurrent(conv, data.messages);
  store.set("area_last:" + areaOf(), conv.id);
  syncParked(conv);
  if (conv.agent_id !== S().agentDetail?.agent.id) setS({ agentDetail: null });
  loadAgentDetail(conv.agent_id || undefined);
  const cur = S().current!;
  if (messageId && cur.msgs[messageId]) {
    patchConv({ current_leaf_id: latestLeaf(cur, cur.msgs[messageId]).id });
    view.scrollIntent = { highlight: messageId };
  } else view.scrollIntent = "bottom";
  setS((s) => ({ openSeq: s.openSeq + 1 }));
  if (push) pushRoute(`/c/${id}`);
  for (const m of data.messages) if (m.status === "streaming" && m.role === "assistant") attachStream(m.id);
  loadDraft();
  if (isMobile()) setSidebar(false);
  focusComposer();
}

export function route({ push = false } = {}) {
  const m = /^#\/c\/(\w+)/.exec(location.hash);
  if (m) openConversation(m[1], { push });
  else newChat({ push, code: location.hash === "#/code" });
}

/** Sidebar destinations: switching area reopens what was last open there (or its empty state). */
export function goArea(area: Area) {
  if (areaOf() === area) {
    if (isMobile()) setSidebar(false);
    return;
  }
  const last = store.get<string | null>("area_last:" + area, null);
  const conv = last && S().convs.find((c) => c.id === last);
  if (conv && (conv.kind === "code") === (area === "code")) openConversation(conv.id);
  else newChat({ code: area === "code" });
}



// ------------------------------------------------------------------ chat actions

function requireModel() {
  const model = selectedModel();
  if (!model || !findModel(model)) {
    const any = allModels().length > 0;
    toast(any ? "O modelo selecionado não está disponível. Escolha outro." : "Conecte um provedor para começar.");
    if (!any) openSettings("providers");
    else view.openModelPicker();
    return null;
  }
  return model;
}

let sending = false;

/** Empty state → a new code session in the last folder used (or asks for one). */
export function newCodeSession() {
  newChat({ code: true });
  if (!S().pendingProject) pickProject();
}

export async function pickProject() {
  try {
    const { path } = await api.pickProject();
    if (!path) return;
    setProject(path);
  } catch (e: any) {
    toast(e.message);
  }
}

export function setProject(path: string) {
  store.set("last_project", path);
  setS({ pendingProject: path, pendingKind: "code", pendingTemporary: false });
  focusComposer();
}

export function isCodeSession(st = S()) {
  return st.current ? st.current.conv.kind === "code" : st.pendingKind === "code";
}

/** Code sessions and agent threads: tool rounds, approvals, corrections while working
 * (a code session only when its runtime takes corrections mid-run). */
export function isAgentic(st = S()) {
  return (isCodeSession(st) && !!currentRuntime(st).caps.steer) || isAgentConv(st.current?.conv);
}

/** Runtime of the next code session. Its permission modes may differ: keep the mode valid. */
export function setRuntime(id: string) {
  store.set("last_runtime", id);
  setS({ pendingRuntime: id, pendingModel: null, pendingEffort: null });
  fitPendingMode();
  focusComposer();
}

function fitPendingMode() {
  const rt = findRuntime(S().pendingRuntime);
  if (rt.modes.length && !rt.modes.includes(S().pendingMode)) setS({ pendingMode: rt.default_mode || rt.modes[0] });
}

/** An agent turn parked on an approval: show its card (the turn itself is not running). */
function syncParked(conv: Conversation) {
  const pa = conv.pending_approval;
  if (pa) setS({ approval: { messageId: pa.message_id, request: pa.request } });
}

export async function setPermissionMode(mode: PermissionMode) {
  const cur = S().current;
  if (cur && cur.conv.kind === "code") {
    patchConv({ permission_mode: mode });
    await api.updateConversation(cur.conv.id, { permission_mode: mode }).catch((e) => toast(e.message));
  } else setS({ pendingMode: mode });
}

/** The mode a plan is carried out in: "Aceitar edições", or the closest one the runtime has. */
export const planExecMode = (): PermissionMode => (currentRuntime().modes.includes("accept_edits") ? "accept_edits" : "auto");

/** Plan mode → carry the plan out: switch to the execution mode and ask for it. */
export async function runPlan() {
  await setPermissionMode(planExecMode());
  setText("Execute o plano acima.");
  await send();
}

/** While a code session works, a message goes to the agent instead of starting a new turn. */
export async function steer() {
  const cur = S().current;
  if (!cur) return;
  const { content } = outgoing();
  if (!content.trim()) return;
  const draft = currentDraftKey();
  try {
    await api.steer(cur.conv.id, content);
  } catch (e: any) {
    toast(e.message);
    return;
  }
  clearComposer(draft);
  toast("Mensagem entregue: o agente lê depois da ação atual");
}

export async function answerApproval(decision: "allow" | "always" | "deny", reason = "") {
  const a = S().approval;
  if (!a) return;
  setS({ approval: null });
  if (a.request.approval_id) {
    await answerParked(a.request.approval_id, S().current?.conv.id || "", decision, reason);
    return;
  }
  try {
    await api.approve(a.messageId, { call_id: a.request.call_id, decision, reason });
  } catch (e: any) {
    toast(e.message);
  }
}

export async function undoTurn(m: Message) {
  try {
    const { restored } = await api.undo(m.id);
    upsertMessage({ id: m.id, undoable: false });
    toast(restored === 1 ? "1 arquivo restaurado" : `${restored} arquivos restaurados`);
  } catch (e: any) {
    toast(e.message);
  }
}

export function openProjectFolder(path: string) {
  api.openProject(path).catch((e) => toast(e.message));
}

/** `@modelo` (another model answering as a participant) exists only in Chat conversations for now. */
export function canCall(st = S()) {
  return st.current ? (st.current.conv.kind || "chat") === "chat" : st.pendingKind === "chat";
}

/** `@Code` / `@Agent` (delegating work to another area): Chat conversations that are kept in history. */
export function canDelegate(st = S()) {
  return canCall(st) && !(st.current ? st.current.conv.temporary : st.pendingTemporary);
}

export async function send() {
  if (sending) return;
  if (S().generating.length) {
    if (isAgentic()) steer();
    return;
  }
  const code = !S().current && S().pendingKind === "code";
  if (code && !S().pendingProject) {
    toast("Escolha a pasta do projeto primeiro.");
    pickProject();
    return;
  }
  // An external harness runs on its own login: a model is optional (null = the CLI's default).
  const external = isCodeSession() && (!!currentRuntime().model_kinds || currentRuntime().family === "redir");
  const model = external ? runtimeModel() : requireModel();
  if (!model && !external) return;
  const effort = model || external ? selectedEffort(model) : null;
  const path = activePath(S().current);
  const parent = path[path.length - 1];
  const { content, attachments } = outgoing();
  const call = canCall() ? useComposer.getState().call : null;
  const draft = currentDraftKey();
  sending = true;
  let res;
  try {
    res = await api.chat({
      conversation_id: S().current?.conv.id || null,
      parent_id: parent?.id || null,
      content,
      attachments,
      model,
      effort,
      call: call && (call.surface === "chat" || canDelegate()) ? call : null,
      temporary: !S().current && !code && S().pendingTemporary,
      ...(code ? { kind: "code" as const, project_path: S().pendingProject!, permission_mode: S().pendingMode, runtime: S().pendingRuntime } : {}),
    });
  } catch (e: any) {
    toast(e.message);
    return;
  } finally {
    sending = false;
  }
  clearComposer(draft);
  view.scrollIntent = "anchor";
  if (!S().current) {
    view.dockTopBefore = document.getElementById("dock")?.getBoundingClientRect().top ?? null;
    setCurrent(res.conversation, [res.user, res.assistant]);
    setS({ pendingModel: null, pendingEffort: null });
    pushRoute(`/c/${res.conversation.id}`);
    view.titleAnim++;
  } else {
    patchConv(res.conversation);
    upsertMessage(res.user);
    upsertMessage(res.assistant);
  }
  attachStream(res.assistant.id);
  refreshConvsSoon();
}

export async function regenerate(message: Message, model?: string | null) {
  if (S().generating.length) return;
  const external = isCodeSession() && (!!currentRuntime().model_kinds || currentRuntime().family === "redir");
  const m = external ? (model === undefined ? message.model ?? null : model) :
    model || (findModel(message.model) ? message.model! : requireModel());
  if (!m && !external) return;
  try {
    const res = await api.regenerate(message.id, { model: m, effort: selectedEffort(m) });
    patchConv(res.conversation);
    upsertMessage(res.assistant);
    view.scrollIntent = { reveal: res.assistant.id };
    attachStream(res.assistant.id);
  } catch (e: any) {
    toast(e.message);
    return;
  }
  refreshConvsSoon();
}

export function startEdit(m: Message) {
  if (S().generating.length) return;
  setS({ editingId: m.id });
}

export function editLast() {
  const path = activePath(S().current);
  for (let i = path.length - 1; i >= 0; i--) if (path[i].role === "user") return startEdit(path[i]);
}

export async function editSubmit(message: Message, content: string) {
  const external = isCodeSession() && (!!currentRuntime().model_kinds || currentRuntime().family === "redir");
  const model = external ? runtimeModel() : requireModel();
  if (!model && !external) return;
  try {
    const res = await api.edit(message.id, { content, model, effort: selectedEffort(model) });
    setS({ editingId: null });
    patchConv(res.conversation);
    upsertMessage(res.user);
    upsertMessage(res.assistant);
    view.scrollIntent = "anchor";
    attachStream(res.assistant.id);
    refreshConvsSoon();
  } catch (e: any) {
    toast(e.message);
  }
}

export function stop() {
  for (const id of S().generating) api.stop(id).catch(() => {});
}

// ------------------------------------------------------------------ rooms

/** Create (convId null) or edit a Room. */
export function openRoomDialog(convId: string | null = null) {
  openDialog({ kind: "room", convId });
}

export async function saveRoom(convId: string | null, room: RoomConfig, title = "") {
  if (convId) {
    const conv = await api.updateConversation(convId, { room });
    if (S().current?.conv.id === convId) patchConv({ room: conv.room });
    return conv;
  }
  const conv = await api.createRoom({ room, title });
  await openConversation(conv.id);
  refreshConvsSoon();
  focusComposer();
  return conv;
}

export function switchBranch(target: Message) {
  const cur = S().current;
  if (!cur) return;
  const leaf = latestLeaf(cur, target);
  view.scrollIntent = "keep";
  patchConv({ current_leaf_id: leaf.id });
  if (leaf.status === "streaming") attachStream(leaf.id);
  api.updateConversation(cur.conv.id, { current_leaf_id: leaf.id }).catch((e) => toast(e.message));
}

export async function removeConversation(c: Conversation) {
  const wasCurrent = S().current?.conv.id === c.id;
  try {
    await api.deleteConversation(c.id);
  } catch (e: any) {
    toast(e.message);
    return;
  }
  setS((s) => ({ convs: s.convs.filter((x) => x.id !== c.id) }));
  if (wasCurrent) newChat();
  store.del("draft:" + c.id);
  toast("Conversa excluída", {
    duration: 6000,
    action: {
      label: "Desfazer",
      fn: async () => {
        await api.restoreConversation(c.id);
        await refreshConvs();
        if (wasCurrent) openConversation(c.id);
      },
    },
  });
}

export async function rename(id: string, title: string) {
  try {
    const conv = await api.updateConversation(id, { title });
    if (S().current?.conv.id === id) patchConv({ title: conv.title });
    refreshConvs();
  } catch (e: any) {
    toast(e.message);
  }
}

export async function togglePin(c: Conversation) {
  try {
    await api.updateConversation(c.id, { pinned: !c.pinned });
  } catch (e: any) {
    toast(e.message);
  }
  refreshConvs();
}

export async function setArchived(c: Conversation, archived: boolean) {
  try {
    await api.updateConversation(c.id, { archived });
  } catch (e: any) {
    toast(e.message);
    return;
  }
  if (archived && S().current?.conv.id === c.id) newChat();
  await refreshConvs();
  toast(archived ? "Conversa arquivada" : "Conversa restaurada", {
    action: archived ? { label: "Desfazer", fn: () => setArchived(c, false) } : undefined,
  });
}

export async function branchFrom(m: Message) {
  try {
    const conv = await api.branch(m.id);
    await refreshConvs();
    await openConversation(conv.id);
    toast("Nova conversa criada a partir desta resposta");
  } catch (e: any) {
    toast(e.message);
  }
}

export async function rate(m: Message, value: 1 | -1) {
  const next = m.feedback === value ? null : value;
  upsertMessage({ id: m.id, feedback: next });
  try {
    await api.feedback(m.id, next);
    if (next) toast(next === 1 ? "Obrigado pela avaliação" : "Avaliação registrada");
  } catch (e: any) {
    upsertMessage({ id: m.id, feedback: m.feedback ?? null });
    toast(e.message);
  }
}

export function setTemporary(on: boolean) {
  if (S().current || S().pendingKind === "code") newChat({ temporary: on, code: false });
  else setS({ pendingTemporary: on });
}

// ------------------------------------------------------------------ read aloud (Web Speech API)

export const canSpeak = () => "speechSynthesis" in window;

export function stopSpeaking() {
  if (canSpeak() && S().speakingId) speechSynthesis.cancel();
  if (S().speakingId) setS({ speakingId: null });
}

export function speak(m: Message) {
  if (!canSpeak()) return toast("A leitura em voz alta não está disponível neste sistema.");
  if (S().speakingId === m.id) return stopSpeaking();
  speechSynthesis.cancel();
  const plain = m.content
    .replace(/```[\s\S]*?```/g, " (bloco de código) ")
    .replace(/[#*_>`|~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const u = new SpeechSynthesisUtterance(plain);
  const { voice_name, voice_rate } = S().settings;
  const voice = speechSynthesis.getVoices().find((v) => v.name === voice_name);
  if (voice) u.voice = voice;
  else u.lang = "pt-BR";
  u.rate = voice_rate || 1;
  u.onend = u.onerror = () => S().speakingId === m.id && setS({ speakingId: null });
  setS({ speakingId: m.id });
  speechSynthesis.speak(u);
}

// ------------------------------------------------------------------ completion notice

let audioCtx: AudioContext | null = null;
function chime() {
  try {
    audioCtx ||= new AudioContext();
    const t = audioCtx.currentTime;
    for (const [f, d] of [[660, 0], [990, 0.09]]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.06, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + d);
      o.stop(t + d + 0.4);
    }
  } catch {
    /* audio unavailable */
  }
}

function notifyDone(m: Message | undefined) {
  const s = S().settings;
  if (!m || m.status !== "complete" || !document.hidden) return;
  if (s.notify_sound) chime();
  if (!s.notify_done || !("Notification" in window) || Notification.permission !== "granted") return;
  const title = S().current?.conv.title || "CEU";
  const n = new Notification(title, { body: (m.content || "Resposta pronta").replace(/\s+/g, " ").slice(0, 140), tag: m.id });
  n.onclick = () => {
    focus();
    n.close();
  };
}

export async function requestNotifications() {
  if (!("Notification" in window)) {
    toast("Notificações não são suportadas aqui.");
    return false;
  }
  if (Notification.permission === "granted") return true;
  const p = await Notification.requestPermission();
  if (p !== "granted") toast("Permissão de notificação negada pelo sistema.");
  return p === "granted";
}

export function exportConversation(c: Conversation) {
  download(`/api/conversations/${c.id}/export`, (c.title || "conversa") + ".md").catch((e) => toast(e.message));
}

export function setModel(ref: string | null) {
  if (S().current) {
    patchConv({ model: ref });
    api.updateConversation(S().current!.conv.id, { model: ref }).catch(() => {});
  } else setS({ pendingModel: ref });
  focusComposer();
}

export function setEffort(lv: string | null) {
  if (S().current) {
    patchConv({ effort: lv });
    api.updateConversation(S().current!.conv.id, { effort: lv }).catch(() => {});
  } else setS({ pendingEffort: lv });
}

export async function providersChanged() {
  await loadState();
}

export function allDeleted() {
  setS({ convs: [] });
  newChat();
  refreshConvs();
}

// ------------------------------------------------------------------ streaming

const streams = new Map<string, () => void>();
/** live copies of streaming messages, flushed into the store at most every ~45ms */
const live = new Map<string, Message>();
let rafPending = false;
let lastFrame = 0;

function setGenerating(ids: string[]) {
  setS({ generating: ids });
}

export function attachStream(id: string) {
  if (streams.has(id)) return;
  if (!S().generating.includes(id)) setGenerating([...S().generating, id]);
  const close = api.stream(id, {
    event(ev: StreamEvent) {
      if (toolEvent(id, ev)) return;
      const base = live.get(id) || S().current?.msgs[id];
      if (!base) return;
      const m: Message = { ...base };
      switch (ev.type) {
        case "snapshot": m.content = ev.content; m.reasoning = ev.reasoning; break;
        case "text": m.content = (m.content || "") + ev.text; break;
        case "reasoning": m.reasoning = (m.reasoning || "") + ev.text; break;
        case "reasoning_done": m.reasoning_ms = ev.ms; break;
        case "reset":
          // a tool round just ran: the server persisted tool_call/tool_result nodes and
          // re-parented this placeholder under them — pull the new tree in
          m.content = ""; m.reasoning = ""; m.reasoning_ms = null;
          reloadSoon();
          break;
        case "notice": m.notice = (m.notice ? m.notice + " " : "") + ev.text; break;
        // a delegated call reached its target: the reply now knows where the work runs
        case "delegate": m.call = ev.call; break;
        case "done": {
          const reparented = ev.message.parent_id !== base.parent_id || !S().current?.msgs[ev.message.parent_id || ""];
          Object.assign(m, ev.message);
          live.set(id, m);
          finish(id);
          if (reparented && ev.message.parent_id) reloadCurrent();
          return;
        }
        case "error":
          m.status = "error";
          m.error = ev.message;
          live.set(id, m);
          finish(id);
          return;
        default:
          return;
      }
      live.set(id, m);
      schedule();
    },
    lost() {
      streams.delete(id);
      // server restarted or connection dropped: reload the message state
      setTimeout(() => reloadCurrent(), 800);
    },
  });
  streams.set(id, close);
}

/** Live tool state (code sessions): kept apart from messages, merged at render time. */
function toolEvent(messageId: string, ev: StreamEvent) {
  const tl = S().toolLive;
  switch (ev.type) {
    case "tool_start":
      setS({ toolLive: { ...tl, [ev.call_id]: { running: true, output: "" } } });
      return true;
    case "tool_output": {
      const prev = tl[ev.call_id] || { running: true, output: "" };
      setS({ toolLive: { ...tl, [ev.call_id]: { ...prev, output: (prev.output + ev.text).slice(-60000) } } });
      return true;
    }
    case "tool_result":
      setS({ toolLive: { ...tl, [ev.result.id]: { ...(tl[ev.result.id] || { output: "" }), running: false, result: ev.result } } });
      return true;
    case "approval":
      setS({ approval: { messageId, request: ev.request } });
      notifyApproval();
      return true;
    case "approval_done":
      if (S().approval?.request.call_id === ev.call_id) setS({ approval: null });
      return true;
    case "steer":
      return true;
  }
  return false;
}

function notifyApproval() {
  const s = S().settings;
  if (!document.hidden) return;
  if (s.notify_sound) chime();
  if (!s.notify_done || !("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(S().current?.conv.title || "CEU", { body: "O agente está aguardando sua aprovação." });
  n.onclick = () => {
    focus();
    n.close();
  };
}

function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(flush);
}

function flush(ts: number) {
  if (ts - lastFrame < 45) {
    requestAnimationFrame(flush);
    return;
  }
  lastFrame = ts;
  rafPending = false;
  flushNow();
}

function flushNow() {
  const cur = S().current;
  if (!cur || !live.size) {
    live.clear();
    return;
  }
  const msgs = { ...cur.msgs };
  for (const [id, m] of live) if (msgs[id]) msgs[id] = m;
  live.clear();
  setS({ current: { ...cur, msgs } });
}

function finish(id: string) {
  streams.get(id)?.();
  streams.delete(id);
  flushNow();
  // an agent turn that parked on an approval: pull the card in if the stream didn't carry it
  if (S().current?.msgs[id]?.status === "waiting" && !S().approval) reloadSoon();
  notifyDone(S().current?.msgs[id]);
  setGenerating(S().generating.filter((x) => x !== id));
  refreshConvsSoon();
}

export function detachAll() {
  for (const close of streams.values()) close();
  streams.clear();
  live.clear();
  if (S().generating.length) setGenerating([]);
  if (S().approval || Object.keys(S().toolLive).length) setS({ approval: null, toolLive: {} });
}

// ------------------------------------------------------------------ server events

export async function reloadCurrent() {
  const cur = S().current;
  if (!cur) return;
  const id = cur.conv.id;
  try {
    const data = await api.conversation(id);
    if (S().current?.conv.id !== id) return;
    detachAll();
    view.scrollIntent = "keep";
    setCurrent(data.conversation, data.messages);
    syncParked(data.conversation);
    for (const m of data.messages) if (m.status === "streaming" && m.role === "assistant") attachStream(m.id);
  } catch {
    /* ignore */
  }
}

const reloadSoon = debounce(() => reloadCurrent(), 120);

/** Cards of the empty chat; the server refreshes them in the background and pings "suggestions". */
export async function loadHomeSuggestions() {
  try {
    const { items } = await api.suggestions();
    setS({ homeSuggestions: items });
  } catch {
    /* keep the last ones */
  }
}

export function onServerEvent(ev: ServerEvent) {
  if (ev.type === "suggestions") return void loadHomeSuggestions();
  if (ev.type === "integrations") return void loadIntegrationsSoon();
  refreshConvsSoon();
  onAgentEvent(ev);
  if (ev.type === "hello") return;
  const cur = S().current;
  if (!cur || ev.conversation_id !== cur.conv.id) {
    if (ev.type === "conversation" && ev.deleted && ev.conversation_id == null && cur) newChat();
    return;
  }
  if (ev.type === "conversation" && ev.deleted) {
    newChat();
    return;
  }
  if (ev.type === "generation" && ev.state === "started" && ev.message_id && !cur.msgs[ev.message_id]) {
    // started from another window: pull the new messages in
    reloadCurrent();
  }
}

// ------------------------------------------------------------------ helpers for shortcuts

export function lastAssistantText() {
  const path = activePath(S().current);
  for (let i = path.length - 1; i >= 0; i--) if (path[i].role === "assistant" && path[i].content) return path[i].content;
  return null;
}

export function sortedConvs(convs: Conversation[], sort: string) {
  return sort === "created" ? [...convs].sort((a, b) => b.created_at - a.created_at) : convs;
}

/** Conversations as the sidebar lists them: the current area only, pinned first. */
export function sidebarOrder() {
  const code = areaOf() === "code";
  const convs = sortedConvs(S().convs, S().settings.sidebar_sort).filter((c) => (c.kind === "code") === code);
  return [...convs.filter((c) => c.pinned), ...convs.filter((c) => !c.pinned)];
}
