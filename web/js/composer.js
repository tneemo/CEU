import { $, h, autosize, formatSize, extOf, store, kbd, isMobile } from './util.js';
import { icon } from './icons.js';
import { S, emit, on, allModels, selectedModel, selectedEffort, effortInfo, prettyModel, findModel, EFFORT_LABELS } from './state.js';
import { api } from './api.js';
import { openPopover, closePopover, listNav, toast } from './ui.js';

const ta = () => $('#input');
let atts = [];
let seq = 0;
let generating = false;

const draftKey = () => 'draft:' + (S.current?.conv?.id || 'new');

export function initComposer() {
  const input = ta();
  $('#attach-btn').innerHTML = icon('attach');
  $('#composer .model-btn .ic').innerHTML = icon('chevron-down');

  input.addEventListener('input', () => {
    autosize(input, innerHeight * 0.4);
    saveDraft();
    updateSend();
  });
  input.addEventListener('keydown', onKey);
  input.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); generating ? emit('stop') : submit(); });
  $('#attach-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { addFiles(Array.from(e.target.files)); e.target.value = ''; });
  $('#model-btn').addEventListener('click', () => openModelPicker());

  on('generating', (g) => { generating = g; updateSend(); });
  updateSend();
}

function onKey(e) {
  const input = ta();
  const ctrlSend = S.settings.send_key === 'ctrl-enter';
  if (e.key === 'Enter' && !e.isComposing) {
    const wantsSend = ctrlSend ? (e.ctrlKey || e.metaKey) : (!e.shiftKey && !isMobile());
    if (wantsSend) {
      e.preventDefault();
      if (!generating) submit();
    }
    return;
  }
  if (e.key === 'Escape' && generating) { e.preventDefault(); emit('stop'); return; }
  if (e.key === 'ArrowUp' && !input.value && !atts.length) {
    e.preventDefault();
    emit('edit-last');
  }
}

function canSend() {
  const hasText = ta().value.trim().length > 0;
  const ready = atts.every((a) => a.status === 'ready');
  return (hasText || atts.length > 0) && ready && atts.every((a) => a.status !== 'error');
}

export function updateSend() {
  const btn = $('#send-btn');
  btn.classList.toggle('is-stop', generating);
  btn.innerHTML = icon(generating ? 'stop' : 'arrow-up');
  btn.setAttribute('aria-label', generating ? 'Interromper' : 'Enviar');
  btn.dataset.tip = generating ? 'Interromper' : 'Enviar';
  if (generating) btn.dataset.kbd = 'Esc'; else delete btn.dataset.kbd;
  btn.disabled = generating ? false : !canSend();
  updateModelButton();
  updateHint();
}

function submit() {
  if (!canSend()) return;
  const content = ta().value;
  const attachments = atts.map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size }));
  emit('send', { content, attachments });
}

/** Called by the controller once the message was accepted by the server. */
export function clearComposer() {
  ta().value = '';
  autosize(ta());
  atts.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
  atts = [];
  renderAtts();
  store.del(draftKey());
  updateSend();
}

export function focusComposer() {
  if (isMobile()) return;
  const input = ta();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function saveDraft() {
  const v = ta().value;
  if (v) store.set(draftKey(), v); else store.del(draftKey());
}

/** Swap drafts when the open conversation changes. */
export function loadDraft() {
  const input = ta();
  input.value = store.get(draftKey(), '') || '';
  autosize(input, innerHeight * 0.4);
  atts = [];
  renderAtts();
  updateSend();
}


// ------------------------------------------------------------------ attachments

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|lua|sh|bash|zsh|ps1|bat|cmd|sql|ya?ml|toml|ini|cfg|conf|env|log|tex|r|scala|dart|vue|svelte|gradle|dockerfile|makefile|gitignore)$/i;

export function addFiles(files) {
  for (const file of files) {
    const mime = file.type || (TEXT_EXT.test(file.name) ? 'text/plain' : '');
    const ok = mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('text/') || TEXT_EXT.test(file.name) || /json|xml|javascript|yaml|csv/.test(mime);
    if (!ok) { toast(`“${file.name}” não é suportado. Anexe texto, código, imagens ou PDF.`); continue; }
    if (file.size > 25 * 1024 * 1024) { toast(`“${file.name}” passa de 25 MB.`); continue; }
    const a = {
      localId: ++seq, name: file.name || 'imagem-colada.png', mime: mime || 'text/plain', size: file.size,
      status: 'uploading', preview: mime.startsWith('image/') ? URL.createObjectURL(file) : null,
    };
    atts.push(a);
    api.upload(file).then((res) => {
      Object.assign(a, { id: res.id, mime: res.mime, status: 'ready' });
    }).catch((err) => {
      a.status = 'error';
      a.error = err.message;
    }).finally(() => { renderAtts(); updateSend(); });
  }
  renderAtts();
  updateSend();
  ta().focus();
}

function renderAtts() {
  const wrap = $('#attachments');
  wrap.innerHTML = '';
  for (const a of atts) {
    const chip = h('div', { class: 'chip' + (a.status === 'uploading' ? ' is-uploading' : '') + (a.status === 'error' ? ' is-error' : ''), title: a.error || a.name });
    if (a.preview) chip.append(h('img', { class: 'thumb', src: a.preview, alt: '' }));
    else chip.append(h('span', { class: 'fi' }, extOf(a.name).slice(0, 4)));
    chip.append(h('span', { class: 'meta' }, h('span', { class: 'n' }, a.name),
      h('span', { class: 's' }, a.status === 'uploading' ? 'Enviando…' : a.status === 'error' ? a.error : formatSize(a.size))));
    const x = h('button', { type: 'button', class: 'x', 'aria-label': `Remover ${a.name}`, html: icon('close') });
    x.addEventListener('click', () => {
      atts = atts.filter((y) => y !== a);
      if (a.preview) URL.revokeObjectURL(a.preview);
      renderAtts();
      updateSend();
      ta().focus();
    });
    chip.append(x);
    wrap.append(chip);
  }
}

// ------------------------------------------------------------------ model picker

export function updateModelButton() {
  const btn = $('#model-btn');
  const ref = selectedModel();
  const models = allModels();
  btn.querySelector('.name').textContent = ref ? prettyModel(ref) : 'Conectar um modelo';
  btn.classList.toggle('is-missing', !models.length || (ref && !findModel(ref)));
  const eff = selectedEffort(ref);
  btn.querySelector('.effort').textContent = eff ? EFFORT_LABELS[eff] : '';
}

function updateHint() {
  const hint = $('#dock-hint');
  hint.innerHTML = '';
  if (!allModels().length) {
    const b = h('button', { type: 'button' }, 'Conectar um provedor');
    b.addEventListener('click', () => emit('settings', 'providers'));
    hint.append('Nenhum modelo disponível. ', b);
    return;
  }
  if ($('#main').classList.contains('is-empty')) {
    const send = S.settings.send_key === 'ctrl-enter' ? kbd('Ctrl ↵') : '↵';
    const nl = S.settings.send_key === 'ctrl-enter' ? '↵' : '⇧ ↵';
    hint.innerHTML = `<kbd>${send}</kbd> envia · <kbd>${nl}</kbd> nova linha · <kbd>${kbd('Ctrl K')}</kbd> buscar`;
  }
}

export function openModelPicker() {
  const anchor = $('#model-btn');
  if (anchor.getAttribute('aria-expanded') === 'true') { closePopover(); return; }
  const models = allModels();
  openPopover({
    anchor, placement: 'top-end', className: 'picker',
    build(el) {
      const input = h('input', { placeholder: 'Buscar modelo…', 'aria-label': 'Buscar modelo', autofocus: models.length > 6 ? true : null });
      const search = h('div', { class: 'picker-search', html: icon('search') }, input);
      const list = h('div', { class: 'picker-list', role: 'listbox' });
      const foot = h('div', { class: 'picker-foot' });
      if (models.length > 6) el.append(search);
      el.append(list, foot);
      const nav = listNav(list);
      const current = selectedModel();

      const draw = () => {
        const q = input.value.trim().toLowerCase();
        list.innerHTML = '';
        if (!models.length) {
          list.append(h('div', { class: 'picker-empty' }, 'Nenhum provedor conectado. Adicione uma chave da Anthropic, OpenAI, OpenRouter ou um servidor local.'));
          return;
        }
        const byProv = new Map();
        for (const m of models) {
          if (q && !(m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.name.toLowerCase().includes(q))) continue;
          if (!byProv.has(m.provider.id)) byProv.set(m.provider.id, []);
          byProv.get(m.provider.id).push(m);
        }
        if (!byProv.size) { list.append(h('div', { class: 'picker-empty' }, 'Nenhum modelo encontrado.')); return; }
        for (const group of byProv.values()) {
          list.append(h('div', { class: 'menu-h' }, group[0].provider.name));
          for (const m of group) {
            const it = h('button', { type: 'button', class: 'menu-item', role: 'option', 'aria-selected': String(m.ref === current) });
            it.innerHTML = `<span class="lbl"></span>${m.ref === current ? `<span class="ic check">${icon('check')}</span>` : ''}`;
            it.querySelector('.lbl').textContent = m.name;
            if (m.name !== m.id) it.querySelector('.lbl').append(h('span', { class: 'sub' }, m.id));
            it.addEventListener('click', () => { closePopover(); emit('model', m.ref); });
            list.append(it);
          }
        }
        nav.set(Math.max(0, [...list.querySelectorAll('.menu-item')].findIndex((x) => x.getAttribute('aria-selected') === 'true')));
      };
      draw();

      const info = effortInfo(current);
      if (info) {
        const eff = selectedEffort(current);
        const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Esforço' });
        for (const lv of info.levels) {
          const b = h('button', { type: 'button', class: lv === eff ? 'is-on' : '', role: 'radio', 'aria-checked': String(lv === eff) }, EFFORT_LABELS[lv]);
          b.addEventListener('click', () => {
            emit('effort', lv);
            seg.querySelectorAll('button').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-checked', String(x === b)); });
          });
          seg.append(b);
        }
        foot.append(h('div', { class: 'effort-row' }, h('span', { class: 'l', title: 'Quanto o modelo raciocina antes de responder' }, 'Esforço'), seg));
      }
      const manage = h('button', { type: 'button', class: 'picker-manage', html: icon('sliders') }, 'Gerenciar provedores');
      manage.addEventListener('click', () => { closePopover(); emit('settings', 'providers'); });
      foot.append(manage);

      input.addEventListener('input', draw);
      el.addEventListener('keydown', (e) => {
        if (nav.key(e)) return;
        if (e.key.length === 1 && document.activeElement !== input && models.length > 6) input.focus();
      });
    },
  });
}
