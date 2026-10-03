import { h, esc, relTime, debounce, kbd } from './util.js';
import { icon } from './icons.js';
import { S, emit } from './state.js';
import { api } from './api.js';
import { openDialog, listNav } from './ui.js';

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// 3: whole text starts with query · 2: a word starts with it · 1: substring · 0: no match
const score = (text, nq) => {
  const n = norm(text);
  if (!nq) return 1;
  if (n.startsWith(nq)) return 3;
  if (n.split(/[^a-z0-9]+/).some((w) => w.startsWith(nq))) return 2;
  return n.includes(nq) ? 1 : 0;
};

function mark(text, q) {
  if (!q) return esc(text);
  const n = norm(text), nq = norm(q);
  const i = n.indexOf(nq);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function actions() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return [
    { label: 'Nova conversa', icon: 'new', kbd: 'Ctrl ⇧ O', run: () => emit('new') },
    { label: 'Trocar modelo', icon: 'cube', kbd: 'Ctrl .', run: () => emit('pick-model') },
    { label: dark ? 'Usar tema claro' : 'Usar tema escuro', icon: dark ? 'sun' : 'moon', run: () => emit('toggle-theme') },
    { label: 'Alternar barra lateral', icon: 'sidebar', kbd: 'Ctrl B', run: () => emit('toggle-sidebar') },
    { label: 'Configurações', icon: 'settings', kbd: 'Ctrl ,', run: () => emit('settings', 'general') },
    { label: 'Provedores e modelos', icon: 'plug', run: () => emit('settings', 'providers') },
    { label: 'Instruções personalizadas', icon: 'text', run: () => emit('settings', 'instructions') },
    { label: 'Atalhos de teclado', icon: 'keyboard', kbd: 'Ctrl /', run: () => emit('settings', 'shortcuts') },
    S.current ? { label: 'Exportar conversa como Markdown', icon: 'download', run: () => { location.href = `/api/conversations/${S.current.conv.id}/export`; } } : null,
  ].filter(Boolean);
}

export function openPalette() {
  const input = h('input', { placeholder: 'Buscar conversas ou executar uma ação…', 'aria-label': 'Buscar', autofocus: true, spellcheck: 'false' });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const el = h('div', { class: 'palette' },
    h('div', { class: 'palette-input', html: icon('search') }, input),
    list,
    h('div', { class: 'palette-foot', html: `<span><kbd>↑</kbd><kbd>↓</kbd>navegar</span><span><kbd>↵</kbd>abrir</span><span><kbd>esc</kbd>fechar</span>` }));
  const close = openDialog(el);
  const nav = listNav(list);
  let serverResults = [];
  let lastQ = '';

  const item = ({ iconName, html, snippet, when, k, run }) => {
    const b = h('button', { type: 'button', class: 'palette-item', role: 'option' });
    b.innerHTML = `<span class="ic">${icon(iconName)}</span><span class="lbl"><span class="t">${html}</span>${snippet ? `<span class="snip">${snippet}</span>` : ''}</span>` +
      (when ? `<span class="when">${esc(when)}</span>` : '') + (k ? `<kbd>${kbd(k)}</kbd>` : '');
    b.addEventListener('click', () => { close(); run(); });
    return b;
  };

  const draw = () => {
    const q = input.value.trim();
    const nq = norm(q);
    list.innerHTML = '';
    const byScore = (get) => (a, b) => score(get(b), nq) - score(get(a), nq);
    const acts = actions().filter((a) => !q || score(a.label, nq)).sort(byScore((a) => a.label));
    const convs = q ? S.convs.filter((c) => score(c.title, nq)).sort(byScore((c) => c.title)).slice(0, 8) : S.convs.slice(0, 7);
    const seen = new Set(convs.map((c) => c.id));
    const msgs = q ? serverResults.filter((r) => r.snippet && !seen.has(r.conversation_id)).slice(0, 8) : [];

    const convNodes = convs.map((c) => item({ iconName: 'chat', html: mark(c.title || 'Nova conversa', q), when: relTime(c.updated_at), run: () => emit('open', c.id) }));
    const msgNodes = msgs.map((r) => item({ iconName: 'search', html: mark(r.title || 'Conversa', ''), snippet: mark(r.snippet, q), when: relTime(r.updated_at), run: () => emit('open', r.conversation_id, r.message_id) }));
    const actNodes = acts.map((a) => item({ iconName: a.icon, html: mark(a.label, q), k: a.kbd, run: a.run }));
    const sections = q
      ? [
        ['Conversas', convNodes, Math.max(0, ...convs.map((c) => score(c.title, nq)))],
        ['Nas mensagens', msgNodes, msgNodes.length ? 0.5 : 0],
        ['Ações', actNodes, Math.max(0, ...acts.map((a) => score(a.label, nq)))],
      ].sort((a, b) => b[2] - a[2])
      : [['Recentes', convNodes, 1], ['Ações', actNodes, 1]];
    for (const [title, nodes] of sections) {
      if (nodes.length) list.append(h('div', { class: 'menu-h' }, title), ...nodes);
    }
    if (!list.childElementCount) list.append(h('div', { class: 'palette-empty' }, q ? `Nada encontrado para “${q}”.` : 'Nenhuma conversa ainda.'));
    nav.set(0);
  };

  const fetchServer = debounce(async () => {
    const q = input.value.trim();
    if (!q) { serverResults = []; return; }
    try {
      const res = await api.search(q);
      if (input.value.trim() === q) { serverResults = res; draw(); }
    } catch { /* offline: local results only */ }
  }, 140);

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q !== lastQ) { lastQ = q; serverResults = []; }
    draw();
    fetchServer();
  });
  input.addEventListener('keydown', (e) => nav.key(e));
  draw();
}
