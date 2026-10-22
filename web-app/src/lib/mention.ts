import { tr } from "../lib/i18n";
// `@` in the composer: finding the token being typed and the participants it can mean — models
// (answer inline) and CEU surfaces (Code on a folder, an Agent), to which the work is delegated.
// Pure helpers; the menu and the chip live in components/Participant.tsx and Composer.tsx.
import type { Agent, CallSpec, ModelEntry } from "../api";
import { prettyModel, type AppState } from "../state/store";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A participant's name: local servers often report a file path as the model (llama.cpp) —
 * keep the file name without extension. Mirrors server/calls.label. */
export function participantName(name: string) {
  if (!/[\\/]/.test(name) || !/\.(gguf|bin|safetensors)$/i.test(name)) return name;
  return name.split(/[\\/]/).pop()!.replace(/\.(gguf|bin|safetensors)$/i, "");
}

export const folderOf = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** A participant ref (server/calls.py): a model ref, `code:<folder>` or `agent:<id>`. */
export function refOfCall(call: CallSpec | null | undefined) {
  if (!call) return null;
  return call.surface === "chat" ? call.target : `${call.surface}:${call.target}`;
}

/** How a participant is named in the UI (mirrors server/calls.label). */
export function participantLabel(ref: string | null | undefined, s: AppState) {
  if (ref?.startsWith("code:")) return "Code · " + folderOf(ref.slice(5));
  if (ref?.startsWith("agent:")) return "Agent · " + (s.agents.find((a) => a.id === ref.slice(6))?.name || tr("removido"));
  return participantName(prettyModel(ref, s.providers));
}

/** What a mention resolves to: a model, or a surface the work is delegated to. */
export type Target =
  | { kind: "model"; key: string; m: ModelEntry }
  | { kind: "code"; key: string; path: string | null; name: string }
  | { kind: "agent"; key: string; a: Agent };

/** The structured call a picked target becomes (the text of the message never carries it). */
export function callOf(t: Target): CallSpec | null {
  if (t.kind === "model") return { surface: "chat", target: t.m.ref };
  if (t.kind === "agent") return { surface: "agent", target: t.a.id };
  return t.path ? { surface: "code", target: t.path } : null;
}

function score(query: string, names: string[], extra: string[] = []) {
  const q = norm(query);
  if (!q) return 0;
  if (names.some((n) => norm(n).startsWith(q))) return 0;
  if (names.some((n) => n.toLowerCase().split(/[\s\-_./:\\·]+/).some((w) => norm(w).startsWith(q)))) return 2;
  if ([...names, ...extra].some((n) => norm(n).includes(q))) return 3;
  return -1;
}

/** Models matching what follows the `@`, best first: name prefix, id prefix, word start, anywhere. */
export function matchModels(models: ModelEntry[], query: string, limit = 8) {
  const q = norm(query);
  const scored: { m: ModelEntry; s: number }[] = [];
  for (const m of models) {
    const shown = participantName(m.name);
    const name = norm(shown);
    const id = norm(m.id.split(/[\\/]/).pop() || m.id);
    let s = -1;
    if (!q || name.startsWith(q)) s = 0;
    else if (id.startsWith(q)) s = 1;
    else if (shown.toLowerCase().split(/[\s\-_./:\\]+/).some((w) => norm(w).startsWith(q))) s = 2;
    else if (name.includes(q) || id.includes(q) || norm(m.provider.name).startsWith(q)) s = 3;
    if (s >= 0) scored.push({ m, s });
  }
  scored.sort((a, b) => a.s - b.s || a.m.name.localeCompare(b.m.name));
  return scored.slice(0, limit).map((x) => x.m);
}

/** Surfaces matching the query: `@code`/`@agent` list them all; a folder or agent name finds its entry.
 * Code offers the recent project folders plus "choose a folder"; Agent, every agent. */
export function matchSurfaces(query: string, projects: { path: string; name: string }[], agents: Agent[], each = 3): Target[] {
  const best = <T,>(items: { t: T; s: number }[]) => items.sort((a, b) => a.s - b.s).slice(0, each).map((x) => x.t);
  const codeWord = score(query, ["Code", "código"]);
  const code: { t: Target; s: number }[] = [];
  for (const p of projects) {
    const s = codeWord >= 0 ? codeWord : score(query, [p.name]);
    if (s >= 0) code.push({ t: { kind: "code", key: "code:" + p.path, path: p.path, name: p.name }, s });
  }
  const codeList = best(code).slice(0, codeWord >= 0 ? each - 1 : each);
  if (codeWord >= 0) codeList.push({ kind: "code", key: "code:?", path: null, name: tr("Escolher pasta…") });
  const agentWord = score(query, ["Agent", "agente"]);
  const agent: { t: Target; s: number }[] = [];
  for (const a of agents) {
    const s = agentWord >= 0 ? agentWord : score(query, [a.name]);
    if (s >= 0) agent.push({ t: { kind: "agent", key: "agent:" + a.id, a }, s });
  }
  // `@agent` lists every agent; otherwise a few of each surface
  return [...codeList, ...(agentWord >= 0 && query ? agent.map((x) => x.t) : best(agent))];
}

/** The `@token` right before the caret, if any: where it starts and the text after `@`.
 * Only at the start or after whitespace, so e-mails and `a@b` never open the picker. */
export function mentionAt(text: string, caret: number) {
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret));
  return m ? { start: m.index + m[1].length, query: m[2] } : null;
}
