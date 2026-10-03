import { $, h, dateGroup } from './util.js';
import { icon } from './icons.js';
import { S, emit } from './state.js';
import { openMenu } from './ui.js';

let seen = new Set();
let firstRender = true;

export function towerBlocks(count) {
  // 1 block per "size step": short chats read as 1, long ones cap at 5
  const n = Math.max(1, Math.min(5, Math.ceil(Math.log2((count || 1) + 1) - 0.4)));
  return n;
}

function tower(count) {
  const t = h('span', { class: 'tower', 'aria-hidden': 'true' });
  for (let i = 0; i < towerBlocks(count); i++) t.append(h('i'));
  return t;
}

export function renderSidebar() {
  const list = $('#sb-list');
  const activeId = S.current?.conv?.id;
  const scroll = list.scrollTop;
  list.innerHTML = '';
  if (!S.convs.length) {
    list.append(h('div', { class: 'sb-empty' }, 'Suas conversas aparecem aqui.'));
    return;
  }
  const groups = new Map();
  const pinned = S.convs.filter((c) => c.pinned);
  if (pinned.length) groups.set('Fixadas', pinned);
  for (const c of S.convs) {
    if (c.pinned) continue;
    const g = dateGroup(c.updated_at);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  for (const [label, convs] of groups) {
    const g = h('div', { class: 'sb-group', role: 'group', 'aria-label': label }, h('div', { class: 'sb-group-h' }, label));
    for (const c of convs) g.append(item(c, c.id === activeId));
    list.append(g);
  }
  list.scrollTop = scroll;
  seen = new Set(S.convs.map((c) => c.id));
  firstRender = false;
}

function item(c, active) {
  const isNew = !firstRender && !seen.has(c.id);
  const el = h('a', {
    class: 'conv' + (active ? ' is-active' : '') + (c.streaming ? ' is-streaming' : '') + (isNew ? ' is-new' : ''),
    href: `/c/${c.id}`,
    role: 'listitem',
    'data-id': c.id,
    'aria-current': active ? 'page' : null,
    draggable: 'false',
  });
  el.append(tower(c.message_count), h('span', { class: 't', title: c.title }, c.title || 'Nova conversa'));
  if (c.pinned) el.append(h('span', { class: 'pin-glyph', html: icon('pin') }));
  const more = h('button', { type: 'button', class: 'more', 'aria-label': 'Opções', html: icon('more') });
  el.append(more);

  el.addEventListener('click', (e) => {
    if (e.target.closest('.more') || e.target.closest('input')) return;
    if (e.ctrlKey || e.metaKey || e.button === 1) return; // let the browser open a new tab
    e.preventDefault();
    emit('open', c.id);
  });
  el.addEventListener('dblclick', (e) => { e.preventDefault(); startRename(c.id); });
  const menu = (opts) => {
    el.classList.add('menu-open');
    openMenu({ ...opts, items: convMenuItems(c), onClose: () => el.classList.remove('menu-open') });
  };
  more.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); menu({ anchor: more, placement: 'bottom-start' }); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }); });
  return el;
}

export function convMenuItems(c) {
  return [
    { label: 'Renomear', icon: 'rename', onSelect: () => startRename(c.id) },
    { label: c.pinned ? 'Desafixar' : 'Fixar', icon: c.pinned ? 'unpin' : 'pin', onSelect: () => emit('pin', c) },
    { label: 'Exportar como Markdown', icon: 'download', onSelect: () => { location.href = `/api/conversations/${c.id}/export`; } },
    'sep',
    { label: 'Excluir', icon: 'trash', danger: true, kbd: 'Ctrl ⇧ ⌫', onSelect: () => emit('delete', c) },
  ];
}

export function startRename(id) {
  const el = $(`#sb-list .conv[data-id="${id}"]`);
  const c = S.convs.find((x) => x.id === id);
  if (!el || !c) {
    emit('rename-title', id);
    return;
  }
  const t = el.querySelector('.t');
  const input = h('input', { class: 'rename', value: c.title, 'aria-label': 'Novo título', maxlength: '120' });
  t.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== c.title) emit('rename', { id, title: v });
    else renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
}
