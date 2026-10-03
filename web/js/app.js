import { $, h, store, debounce, isMobile, copyText, reducedMotion } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { api } from './api.js';
import { S, on, emit, setCurrent, upsertMessage, activePath, latestLeaf, selectedModel, selectedEffort, allModels, findModel } from './state.js';
import { renderSidebar, convMenuItems, startRename } from './sidebar.js';
import { renderThread, anchorToLastTurn, attachStream, detachAll, initThread, startEdit, lastAssistantText, lastUserMessage, updateToBottom } from './thread.js';
import { initComposer, clearComposer, focusComposer, loadDraft, addFiles, openModelPicker, updateSend, updateModelButton } from './composer.js';
import { initTooltips, toast, openMenu, isDialogOpen, closePopover, isPopoverOpen, closeTopDialog } from './ui.js';
import { openPalette } from './palette.js';
import { openSettings } from './settings.js';
import { Ambient, HistoryField } from './field.js';

const main = $('#main');
let ambient, field;
let opening = 0;

// ------------------------------------------------------------------ appearance

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const t = S.settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  store.raw('theme', t);
  ambient?.refreshTheme();
  field?.refreshTheme();
}

function applySettings() {
  applyTheme();
  const fs = S.settings.font_size || 15;
  document.documentElement.style.setProperty('--fs-body', fs + 'px');
  store.raw('font', String(fs));
  ambient?.setEnabled(S.settings.ambient !== false && !reducedMotion());
  updateSend();
}

function setSidebar(open) {
  if (isMobile()) {
    document.documentElement.dataset.drawer = open ? 'open' : 'closed';
    return;
  }
  document.documentElement.dataset.sidebar = open ? 'open' : 'closed';
  store.raw('sidebar', open ? 'open' : 'closed');
}

function toggleSidebar() {
  if (isMobile()) setSidebar(document.documentElement.dataset.drawer !== 'open');
  else setSidebar(document.documentElement.dataset.sidebar === 'closed');
}

// ------------------------------------------------------------------ data

async function loadState() {
  const st = await api.state();
  S.providers = st.providers;
  S.settings = st.settings;
  S.presets = st.presets;
  S.efforts = st.efforts;
}

const refreshConvs = async () => {
  try {
    S.convs = await api.conversations();
  } catch { return; }
  renderSidebar();
  if (!S.current) {
    $('#field-wrap').hidden = !S.convs.length;
    field.setData(S.convs);
  }
  if (S.current) {
    const c = S.convs.find((x) => x.id === S.current.conv.id);
    if (c && c.title !== S.current.conv.title) {
      S.current.conv.title = c.title;
      setTitle(c.title, true);
    }
  }
};
const refreshConvsSoon = debounce(refreshConvs, 150);

function setTitle(title, animate = false) {
  const btn = $('#tb-title');
  if (!S.current) { btn.hidden = true; document.title = 'CEU'; return; }
  btn.hidden = false;
  btn.querySelector('.t').textContent = title || 'Nova conversa';
  document.title = `${title || 'Nova conversa'} — CEU`;
  if (animate) { btn.classList.remove('is-new'); void btn.offsetWidth; btn.classList.add('is-new'); }
}

// ------------------------------------------------------------------ navigation

function newChat({ push = true } = {}) {
  detachAll();
  S.current = null;
  main.classList.add('is-empty');
  setTitle();
  if (push && location.pathname !== '/') history.pushState({}, '', '/');
  loadDraft();
  renderSidebar();
  field.setData(S.convs);
  $('#field-wrap').hidden = !S.convs.length;
  setSidebar(isMobile() ? false : document.documentElement.dataset.sidebar !== 'closed');
  updateSend();
  focusComposer();
}

async function openConversation(id, { push = true, messageId = null } = {}) {
  if (S.current?.conv.id === id && !messageId) { if (isMobile()) setSidebar(false); return; }
  const ticket = ++opening;
  let data;
  try {
    data = await api.conversation(id);
  } catch (e) {
    toast(e.status === 404 ? 'Esta conversa não existe mais.' : e.message);
    if (!S.current) newChat({ push: false });
    return;
  }
  if (ticket !== opening) return; // a newer navigation won
  detachAll();
  setCurrent(data.conversation, data.messages);
  if (messageId && S.current.msgs.has(messageId)) {
    S.current.conv.current_leaf_id = latestLeaf(S.current.msgs.get(messageId)).id;
  }
  main.classList.remove('is-empty');
  setTitle(data.conversation.title);
  if (push) history.pushState({}, '', `/c/${id}`);
  renderThread({ entering: true });
  for (const m of S.current.msgs.values()) if (m.status === 'streaming') attachStream(m.id);
  loadDraft();
  renderSidebar();
  if (isMobile()) setSidebar(false);
  updateSend();
  if (messageId) {
    const el = document.querySelector(`.msg[data-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.animate([{ background: 'var(--accent-2)' }, { background: 'transparent' }], { duration: 1600, easing: 'ease-out' });
    }
  }
  focusComposer();
}

function route({ push = false } = {}) {
  const m = /^\/c\/(\w+)/.exec(location.pathname);
  if (m) openConversation(m[1], { push });
  else newChat({ push });
}

// ------------------------------------------------------------------ chat actions

function requireModel() {
  const model = selectedModel();
  if (!model || !findModel(model)) {
    toast(allModels().length ? 'O modelo selecionado não está disponível. Escolha outro.' : 'Conecte um provedor para começar.');
    if (!allModels().length) openSettings('providers'); else openModelPicker();
    return null;
  }
  return model;
}

/** Move the composer from the centred empty state to the bottom with a FLIP transition. */
function leaveEmptyState() {
  const dock = $('#dock');
  const before = dock.getBoundingClientRect().top;
  main.classList.remove('is-empty');
  const after = dock.getBoundingClientRect().top;
  if (!reducedMotion() && Math.abs(before - after) > 2) {
    dock.animate([{ transform: `translateY(${before - after}px)` }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
}

async function send({ content, attachments }) {
  const model = requireModel();
  if (!model) return;
  const effort = selectedEffort(model);
  const path = activePath();
  const parent = path[path.length - 1];
  $('#send-btn').disabled = true;
  let res;
  try {
    res = await api.chat({ conversation_id: S.current?.conv.id || null, parent_id: parent?.id || null, content, attachments, model, effort });
  } catch (e) {
    toast(e.message);
    updateSend();
    return;
  }
  if (!S.current) {
    clearComposer();
    setCurrent(res.conversation, [res.user, res.assistant]);
    S.pendingModel = null;
    S.pendingEffort = null;
    history.pushState({}, '', `/c/${res.conversation.id}`);
    leaveEmptyState();
    setTitle(res.conversation.title, true);
  } else {
    clearComposer();
    S.current.conv = res.conversation;
    upsertMessage(res.user);
    upsertMessage(res.assistant);
  }
  renderThread({ anchorLast: true, entering: false });
  anchorToLastTurn();
  attachStream(res.assistant.id);
  refreshConvsSoon();
}

async function regenerate({ message, model }) {
  if (S.generating.size) return;
  const m = model || (findModel(message.model) ? message.model : requireModel());
  if (!m) return;
  try {
    const res = await api.regenerate(message.id, { model: m, effort: selectedEffort(m) });
    S.current.conv = res.conversation;
    upsertMessage(res.assistant);
  } catch (e) { toast(e.message); return; }
  renderThread({ keepScroll: true });
  const id = S.current.conv.current_leaf_id;
  attachStream(id);
  const el = document.querySelector(`.msg[data-id="${id}"]`);
  const t = $('#thread');
  if (el && el.getBoundingClientRect().top > t.getBoundingClientRect().bottom - 80) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  refreshConvsSoon();
}

async function editSubmit({ message, content }) {
  const model = requireModel();
  if (!model) return;
  try {
    const res = await api.edit(message.id, { content, model, effort: selectedEffort(model) });
    S.current.conv = res.conversation;
    upsertMessage(res.user);
    upsertMessage(res.assistant);
    renderThread({ anchorLast: true });
    anchorToLastTurn();
    attachStream(res.assistant.id);
    refreshConvsSoon();
  } catch (e) { toast(e.message); }
}

function stop() {
  for (const id of S.generating) api.stop(id).catch(() => {});
}

async function switchBranch(target) {
  const leaf = latestLeaf(target);
  S.current.conv.current_leaf_id = leaf.id;
  renderThread({ keepScroll: true });
  if (leaf.status === 'streaming') attachStream(leaf.id);
  api.updateConversation(S.current.conv.id, { current_leaf_id: leaf.id }).catch((e) => toast(e.message));
}

async function removeConversation(c) {
  const wasCurrent = S.current?.conv.id === c.id;
  try { await api.deleteConversation(c.id); } catch (e) { toast(e.message); return; }
  S.convs = S.convs.filter((x) => x.id !== c.id);
  if (wasCurrent) newChat();
  else renderSidebar();
  store.del('draft:' + c.id);
  toast('Conversa excluída', {
    duration: 6000,
    action: {
      label: 'Desfazer',
      fn: async () => {
        await api.restoreConversation(c.id);
        await refreshConvs();
        if (wasCurrent) openConversation(c.id);
      },
    },
  });
}

function renameInTopbar() {
  if (!S.current) return;
  const btn = $('#tb-title');
  const input = h('input', { class: 'input', value: S.current.conv.title, style: { height: '30px', width: 'min(420px, 50vw)' }, 'aria-label': 'Título da conversa' });
  btn.hidden = true;
  btn.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.remove();
    btn.hidden = false;
    if (save && v && v !== S.current.conv.title) emit('rename', { id: S.current.conv.id, title: v });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// ------------------------------------------------------------------ keyboard

function sidebarOrder() {
  return [...S.convs.filter((c) => c.pinned), ...S.convs.filter((c) => !c.pinned)];
}

function onKeydown(e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;

  if (mod && k === 'k') { e.preventDefault(); if (!isDialogOpen()) { closePopover(); openPalette(); } else closeTopDialog(); return; }
  if (isDialogOpen()) {
    if (e.key === 'Escape' && !isPopoverOpen()) { e.preventDefault(); closeTopDialog(); }
    return;
  }
  if (mod && e.shiftKey && k === 'o') { e.preventDefault(); newChat(); return; }
  if (mod && !e.shiftKey && k === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (mod && (e.key === '.' || e.code === 'Period')) { e.preventDefault(); openModelPicker(); return; }
  if (mod && e.key === ',') { e.preventDefault(); openSettings('general'); return; }
  if (mod && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); openSettings('shortcuts'); return; }
  if (mod && e.shiftKey && k === 'c') {
    if (window.getSelection()?.toString()) return;
    const t = lastAssistantText();
    if (t) { e.preventDefault(); copyText(t).then(() => toast('Última resposta copiada')); }
    return;
  }
  if (mod && e.shiftKey && e.key === 'Backspace' && S.current) {
    e.preventDefault();
    const c = S.convs.find((x) => x.id === S.current.conv.id) || S.current.conv;
    removeConversation(c);
    return;
  }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const list = sidebarOrder();
    if (!list.length) return;
    const i = S.current ? list.findIndex((c) => c.id === S.current.conv.id) : -1;
    const next = e.key === 'ArrowDown' ? list[Math.min(list.length - 1, i + 1)] : list[Math.max(0, i - 1)];
    if (next) openConversation(next.id);
    return;
  }
  if (e.shiftKey && e.key === 'Escape') { e.preventDefault(); $('#input').focus(); return; }
  if (e.key === 'Escape' && !isPopoverOpen()) {
    if (document.documentElement.dataset.drawer === 'open') { setSidebar(false); return; }
    if (S.generating.size && !inField) { stop(); return; }
  }
  // Type-to-focus: printable keys anywhere go to the composer.
  if (!inField && !mod && !e.altKey && e.key.length === 1 && !isPopoverOpen()) {
    $('#input').focus();
  }
}

// ------------------------------------------------------------------ drag & drop

function initDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.classList.add('is-visible'); });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('is-visible'); });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('is-visible');
    addFiles(Array.from(e.dataTransfer.files));
  });
}

// ------------------------------------------------------------------ server events

function onServerEvent(ev) {
  if (ev.type === 'hello') { refreshConvsSoon(); return; }
  refreshConvsSoon();
  if (!S.current || ev.conversation_id !== S.current.conv.id) return;
  if (ev.type === 'conversation' && ev.deleted) { newChat(); return; }
  if (ev.type === 'generation' && ev.state === 'started' && !S.current.msgs.has(ev.message_id)) {
    // started from another window: pull the new messages in
    reloadCurrent();
  }
}

async function reloadCurrent() {
  if (!S.current) return;
  const id = S.current.conv.id;
  try {
    const data = await api.conversation(id);
    if (S.current?.conv.id !== id) return;
    detachAll();
    setCurrent(data.conversation, data.messages);
    renderThread({ keepScroll: true });
    for (const m of S.current.msgs.values()) if (m.status === 'streaming') attachStream(m.id);
    updateSend();
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ boot

async function boot() {
  hydrateIcons();
  $('#sb-collapse').innerHTML = icon('sidebar');
  $('#tb-sidebar').innerHTML = icon('sidebar');
  $('#tb-menu').innerHTML = icon('menu');
  $('#tb-new').innerHTML = icon('new');

  document.addEventListener('keydown', onKeydown);
  ambient = new Ambient($('#ambient'));
  field = new HistoryField($('#field'), $('#field-label'), { onOpen: (id) => openConversation(id) });

  try {
    await loadState();
  } catch (e) {
    document.body.append(h('div', { class: 'toast', style: { position: 'fixed', left: '50%', top: '40%', transform: 'translateX(-50%)' } }, e.message));
    return;
  }
  applySettings();
  darkQuery.addEventListener('change', applyTheme);

  initTooltips();
  initThread();
  initComposer();
  initDrop();

  $('#sb-new').addEventListener('click', () => newChat());
  $('#tb-new').addEventListener('click', () => newChat());
  $('.brand').addEventListener('click', (e) => { e.preventDefault(); newChat(); });
  $('#sb-search').addEventListener('click', () => openPalette());
  $('#sb-settings').addEventListener('click', () => openSettings('general'));
  $('#sb-collapse').addEventListener('click', () => setSidebar(false));
  $('#tb-sidebar').addEventListener('click', () => setSidebar(true));
  $('#tb-menu').addEventListener('click', () => setSidebar(true));
  $('#scrim').addEventListener('click', () => setSidebar(false));
  $('#tb-title').addEventListener('click', (e) => {
    if (!S.current) return;
    const c = S.convs.find((x) => x.id === S.current.conv.id) || S.current.conv;
    openMenu({ anchor: e.currentTarget, placement: 'bottom-start', items: convMenuItems(c) });
  });
  $('#tb-title').addEventListener('dblclick', renameInTopbar);
  addEventListener('popstate', () => route({ push: false }));

  on('open', (id, messageId) => openConversation(id, { messageId }));
  on('new', () => newChat());
  on('send', send);
  on('stop', stop);
  on('regenerate', regenerate);
  on('edit-submit', editSubmit);
  on('edit-last', () => { const m = lastUserMessage(); if (m) startEdit(m); });
  on('branch', switchBranch);
  on('model', (ref) => {
    if (S.current) {
      S.current.conv.model = ref;
      api.updateConversation(S.current.conv.id, { model: ref }).catch(() => {});
    } else S.pendingModel = ref;
    updateModelButton();
    focusComposer();
  });
  on('effort', (lv) => {
    if (S.current) {
      S.current.conv.effort = lv;
      api.updateConversation(S.current.conv.id, { effort: lv }).catch(() => {});
    } else S.pendingEffort = lv;
    updateModelButton();
  });
  on('pick-model', () => openModelPicker());
  on('pin', async (c) => { await api.updateConversation(c.id, { pinned: !c.pinned }); refreshConvs(); });
  on('rename', async ({ id, title }) => {
    try {
      const conv = await api.updateConversation(id, { title });
      if (S.current?.conv.id === id) { S.current.conv.title = conv.title; setTitle(conv.title); }
      refreshConvs();
    } catch (e) { toast(e.message); }
  });
  on('rename-title', () => renameInTopbar());
  on('delete', removeConversation);
  on('settings', (section) => openSettings(section));
  on('toggle-theme', async () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    S.settings = await api.settings({ theme: dark ? 'light' : 'dark' });
    applySettings();
  });
  on('toggle-sidebar', toggleSidebar);
  on('settings-changed', () => { applySettings(); updateModelButton(); });
  on('providers-changed', async () => { await loadState(); updateSend(); });
  on('all-deleted', async () => { S.convs = []; newChat(); refreshConvs(); });
  on('generating', (g) => { ambient.setActivity(g ? 1 : 0); });
  on('stream-done', () => { refreshConvsSoon(); updateToBottom(); });
  on('stream-lost', () => reloadCurrent());

  S.convs = await api.conversations().catch(() => []);
  renderSidebar();
  api.events(onServerEvent);
  route();
  $('#field-wrap').hidden = !S.convs.length;
  // Sidebar rename via F2 on focused item
  $('#sb-list').addEventListener('keydown', (e) => {
    const it = e.target.closest('.conv');
    if (e.key === 'F2' && it) { e.preventDefault(); startRename(it.dataset.id); }
  });
}

boot();
