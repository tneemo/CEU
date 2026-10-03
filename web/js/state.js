// Central client state + tiny event emitter.
const listeners = new Map();

export const S = {
  providers: [],
  settings: {},
  presets: {},
  efforts: {},
  convs: [],
  current: null, // { conv, msgs: Map<id,msg>, children: Map<parentId|'root', msg[]> }
  pendingModel: null, // model chosen while no conversation is open
  pendingEffort: null,
  generating: new Set(), // message ids streaming in the open conversation
};

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}

export function emit(evt, ...args) {
  const fns = [...(listeners.get(evt) || [])];
  return Promise.all(fns.map((fn) => fn(...args)));
}

// ------------------------------------------------------------------ conversation tree

export function setCurrent(conv, messages) {
  const msgs = new Map(messages.map((m) => [m.id, m]));
  S.current = { conv, msgs, children: new Map() };
  reindex();
}

export function reindex() {
  const c = S.current;
  if (!c) return;
  c.children = new Map();
  for (const m of c.msgs.values()) {
    const k = m.parent_id || 'root';
    if (!c.children.has(k)) c.children.set(k, []);
    c.children.get(k).push(m);
  }
  for (const list of c.children.values()) list.sort((a, b) => a.created_at - b.created_at);
}

export function upsertMessage(m) {
  if (!S.current) return;
  const had = S.current.msgs.has(m.id);
  S.current.msgs.set(m.id, { ...(S.current.msgs.get(m.id) || {}), ...m });
  if (!had) reindex();
}

/** Messages on the active branch, root → leaf. */
export function activePath() {
  const c = S.current;
  if (!c) return [];
  let leaf = c.conv.current_leaf_id && c.msgs.get(c.conv.current_leaf_id);
  if (!leaf) {
    // fall back to the most recent message
    leaf = [...c.msgs.values()].sort((a, b) => b.created_at - a.created_at)[0];
  }
  const out = [];
  const seen = new Set();
  while (leaf && !seen.has(leaf.id)) {
    seen.add(leaf.id);
    out.push(leaf);
    leaf = leaf.parent_id ? c.msgs.get(leaf.parent_id) : null;
  }
  return out.reverse();
}

export function siblings(m) {
  return (S.current?.children.get(m.parent_id || 'root') || []).filter((x) => x.role === m.role);
}

/** Deepest most-recent descendant — where a branch "continues". */
export function latestLeaf(m) {
  let cur = m;
  for (;;) {
    const kids = S.current.children.get(cur.id);
    if (!kids?.length) return cur;
    cur = kids[kids.length - 1];
  }
}

// ------------------------------------------------------------------ models

export function allModels() {
  const out = [];
  for (const p of S.providers) {
    if (!p.enabled) continue;
    for (const m of p.models) out.push({ ref: `${p.id}::${m.id}`, id: m.id, name: m.name || m.id, provider: p });
  }
  return out;
}

export function findModel(ref) {
  if (!ref) return null;
  return allModels().find((m) => m.ref === ref) || null;
}

export function prettyModel(ref) {
  const m = findModel(ref);
  if (m) return m.name;
  if (!ref) return 'Sem modelo';
  return ref.split('::').pop();
}

export function selectedModel() {
  const ref = S.current?.conv?.model_override || S.current?.conv?.model || S.pendingModel || S.settings.default_model;
  if (findModel(ref)) return ref;
  const fallback = findModel(S.settings.default_model) ? S.settings.default_model : allModels()[0]?.ref;
  return fallback || ref || null;
}

export function effortInfo(ref) {
  return S.efforts[ref] || null;
}

export function selectedEffort(ref = selectedModel()) {
  const info = effortInfo(ref);
  if (!info) return null;
  const e = S.current ? (S.current.conv.effort_override ?? S.current.conv.effort) : S.pendingEffort;
  return info.levels.includes(e) ? e : info.default;
}

export const EFFORT_LABELS = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
