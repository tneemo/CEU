import { $, $$, h, copyText, formatSize, extOf, autosize, reducedMotion } from './util.js';
import { icon } from './icons.js';
import { S, emit, activePath, siblings, prettyModel, allModels } from './state.js';
import { renderMarkdown } from './markdown.js';
import { api } from './api.js';
import { openMenu } from './ui.js';

const thread = () => $('#thread');
const inner = () => $('#thread-inner');
const streams = new Map(); // msgId -> close()
const dirty = new Set();
let rafPending = false;
let lastFrame = 0;

// ------------------------------------------------------------------ render

export function renderThread({ entering = false, keepScroll = false, anchorLast = false } = {}) {
  const el = inner();
  const t = thread();
  const prevTop = t.scrollTop;
  const hadAnchor = el.querySelector('.turn.is-anchor')?.dataset.first;
  el.innerHTML = '';
  const path = activePath();
  let turn = null;
  path.forEach((m, i) => {
    if (m.role === 'user' || !turn) {
      turn = h('div', { class: 'turn', 'data-first': m.id });
      el.append(turn);
    }
    const node = m.role === 'user' ? userEl(m) : (m.role === 'tool_call' || m.role === 'tool_result') ? toolEl(m) : assistantEl(m);
    if (i === path.length - 1) node.classList.add('is-last');
    turn.append(node);
  });
  if (entering && !reducedMotion()) {
    el.classList.remove('is-entering');
    void el.offsetWidth;
    el.classList.add('is-entering');
  }
  const last = el.lastElementChild;
  if (last && (anchorLast || (keepScroll && hadAnchor === last.dataset.first))) setAnchor(last);
  if (keepScroll) t.scrollTop = prevTop;
  else if (!anchorLast) t.scrollTop = t.scrollHeight;
  updateRail();
  updateToBottom();
}

function setAnchor(turn) {
  $$('.turn.is-anchor', inner()).forEach((x) => x !== turn && x.classList.remove('is-anchor'));
  turn.classList.add('is-anchor');
  turn.style.setProperty('--anchor-h', Math.max(0, thread().clientHeight - 24) + 'px');
}

/** Bring the last turn's user message to the top of the viewport (ChatGPT-style). */
export function anchorToLastTurn({ smooth = true } = {}) {
  const turn = inner().lastElementChild;
  if (!turn) return;
  setAnchor(turn);
  const t = thread();
  const top = turn.offsetTop - 8;
  t.scrollTo({ top, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

// ------------------------------------------------------------------ user message

function attUrl(a) {
  if (a.source === 'workspace') {
    const cid = S.current?.conv?.id;
    return `/api/conversations/${cid}/workspace/${a.id.split('/').map(encodeURIComponent).join('/')}`;
  }
  return `/api/attachments/${a.id}`;
}

function attachmentsEl(atts) {
  const wrap = h('div', { class: 'msg-atts' });
  for (const a of atts) {
    const url = attUrl(a);
    if (a.mime?.startsWith('image/')) {
      wrap.append(h('a', { class: 'att-img', href: url, target: '_blank', rel: 'noopener', title: a.name },
        h('img', { src: url, alt: a.name, loading: 'lazy' })));
    } else {
      wrap.append(h('a', { class: 'att-file', href: url, download: a.name, title: a.name },
        h('span', { class: 'fi' }, extOf(a.name).slice(0, 4)),
        h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: '0' } },
          h('span', { class: 'n' }, a.name), h('span', { class: 's' }, formatSize(a.size || 0))),
        h('span', { class: 'ic dl', html: icon('download') })));
    }
  }
  return wrap;
}

// ------------------------------------------------------------------ tool call / result

function toolEl(m) {
  const el = h('div', { class: 'msg tool', 'data-id': m.id });
  if (m.content?.trim()) {
    const md = h('div', { class: 'md' });
    md.innerHTML = renderMarkdown(m.content);
    el.append(md);
  }
  const isResult = m.role === 'tool_result';
  const hasError = isResult && /ERRO:/.test(m.notice || '');
  const card = h('div', { class: 'tool-card' + (isResult ? ' is-result' : '') + (hasError ? ' is-error' : '') },
    h('span', { class: 'ic', html: icon(hasError ? 'alert' : (isResult ? 'check' : 'cube')) }),
    h('pre', { class: 'body' }, m.notice || (isResult ? '(sem saída)' : 'Executando ferramenta…')));
  el.append(card);
  if (isResult && m.attachments?.length) el.append(attachmentsEl(m.attachments));
  return el;
}

function userEl(m) {
  const el = h('div', { class: 'msg user', 'data-id': m.id });
  if (m.attachments?.length) el.append(attachmentsEl(m.attachments));
  if (m.content) {
    const bubble = h('div', { class: 'bubble' }, m.content);
    el.append(bubble);
    requestAnimationFrame(() => {
      if (bubble.scrollHeight > 17 * parseFloat(getComputedStyle(bubble).fontSize) * 1.6 && !bubble.dataset.expanded) {
        bubble.classList.add('is-clamped');
        const btn = h('button', { type: 'button', class: 'expand-btn' }, 'Mostrar mais');
        btn.addEventListener('click', () => {
          const clamped = bubble.classList.toggle('is-clamped');
          bubble.dataset.expanded = clamped ? '' : '1';
          btn.textContent = clamped ? 'Mostrar mais' : 'Mostrar menos';
        });
        bubble.after(btn);
      }
    });
  }
  const actions = h('div', { class: 'actions' });
  const copy = iconBtn('copy', 'Copiar', () => copyWithFeedback(copy, m.content));
  actions.append(branchNav(m), iconBtn('edit', 'Editar', () => startEdit(m)), copy);
  el.append(actions);
  return el;
}

function iconBtn(name, tip, onClick, extra = {}) {
  const b = h('button', { type: 'button', class: 'icon-btn', 'aria-label': tip, 'data-tip': tip, html: icon(name), ...extra });
  b.addEventListener('click', onClick);
  return b;
}

async function copyWithFeedback(btn, text) {
  const ok = await copyText(text);
  if (!ok || !btn) return;
  btn.innerHTML = icon('check');
  btn.classList.add('is-on');
  setTimeout(() => { btn.innerHTML = icon('copy'); btn.classList.remove('is-on'); }, 1400);
}

function branchNav(m) {
  const sibs = siblings(m);
  if (sibs.length < 2) return h('span');
  const i = sibs.findIndex((x) => x.id === m.id);
  const wrap = h('span', { class: 'branch' });
  const prev = iconBtn('chevron-left', 'Versão anterior', () => emit('branch', sibs[i - 1]));
  const next = iconBtn('chevron-right', 'Próxima versão', () => emit('branch', sibs[i + 1]));
  prev.disabled = i <= 0;
  next.disabled = i >= sibs.length - 1;
  wrap.append(prev, h('span', {}, `${i + 1} / ${sibs.length}`), next);
  return wrap;
}

// ------------------------------------------------------------------ inline edit

export function startEdit(m) {
  const el = $(`.msg[data-id="${m.id}"]`, inner());
  if (!el || el.querySelector('.edit-box')) return;
  if (S.generating.size) return;
  const ta = h('textarea', { rows: '1', 'aria-label': 'Editar mensagem' });
  ta.value = m.content;
  const cancel = () => renderThread({ keepScroll: true });
  const submit = () => {
    const v = ta.value;
    if (!v.trim() && !m.attachments?.length) return;
    if (v === m.content) { cancel(); return; }
    emit('edit-submit', { message: m, content: v });
  };
  const box = h('div', { class: 'edit-box' }, ta, h('div', { class: 'row' },
    h('button', { type: 'button', class: 'btn ghost', onclick: cancel }, 'Cancelar'),
    h('button', { type: 'button', class: 'btn primary', onclick: submit }, 'Enviar')));
  el.innerHTML = '';
  if (m.attachments?.length) el.append(attachmentsEl(m.attachments));
  el.append(box);
  ta.addEventListener('input', () => autosize(ta, innerHeight * 0.5));
  ta.addEventListener('keydown', (e) => {
    const ctrlSend = S.settings.send_key === 'ctrl-enter';
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && !e.isComposing && (ctrlSend ? (e.ctrlKey || e.metaKey) : !e.shiftKey)) { e.preventDefault(); submit(); }
  });
  autosize(ta, innerHeight * 0.5);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ------------------------------------------------------------------ assistant message

function cubeEl() {
  const w = h('span', { class: 'cube-wrap' });
  const c = h('span', { class: 'cube' });
  for (let i = 0; i < 6; i++) c.append(h('i'));
  w.append(c);
  return w;
}

function assistantEl(m) {
  const el = h('div', { class: 'msg assistant', 'data-id': m.id });
  el._p = {};
  updateAssistant(el, m, true);
  return el;
}

function lastLine(text) {
  const t = text.trim().split('\n').filter((l) => l.trim()).pop() || '';
  return t.replace(/[*_#`>]/g, '').slice(-120);
}

function secs(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`;
}

function updateAssistant(el, m, initial = false) {
  const p = el._p;
  const streaming = m.status === 'streaming';
  const thinkingNow = streaming && m.reasoning && !m.content;

  // reasoning block
  if (m.reasoning) {
    if (!p.reasoning) {
      p.reasoning = h('div', { class: 'reasoning' });
      p.toggle = h('button', { type: 'button', class: 'reasoning-toggle', 'aria-expanded': 'false' });
      p.body = h('div', { class: 'reasoning-body md' });
      p.toggle.addEventListener('click', () => {
        const open = p.reasoning.classList.toggle('is-open');
        p.toggle.setAttribute('aria-expanded', String(open));
        if (open) p.body.innerHTML = renderMarkdown(m._live?.reasoning ?? m.reasoning);
      });
      p.reasoning.append(p.toggle, p.body);
      el.prepend(p.reasoning);
    }
    const state = thinkingNow ? 'live' : 'done';
    if (p.toggleState !== state || thinkingNow) {
      p.toggle.innerHTML = '';
      if (thinkingNow) {
        p.toggle.append(cubeEl(), h('span', { class: 'label' }, 'Pensando'), h('span', { class: 'live' }, lastLine(m.reasoning)));
      } else {
        p.toggle.append(h('span', { class: 'chev', html: icon('chevron-right') }),
          h('span', {}, m.reasoning_ms ? `Pensou por ${secs(m.reasoning_ms)}` : 'Raciocínio'));
      }
      p.toggleState = state;
    }
    if (p.reasoning.classList.contains('is-open')) p.body.innerHTML = renderMarkdown(m.reasoning);
  }

  // pending indicator
  const showPending = streaming && !m.content && !m.reasoning;
  if (showPending && !p.pending) {
    p.pending = h('div', { class: 'pending' }, cubeEl(), h('span', { class: 'label' }, 'Gerando'));
    el.append(p.pending);
  } else if (!showPending && p.pending) {
    p.pending.remove();
    p.pending = null;
  }

  // content
  if (m.content || !streaming) {
    if (!p.md) {
      p.md = h('div', { class: 'md' });
      (p.pending || null) ? p.pending.after(p.md) : el.append(p.md);
      if (!initial) el.classList.add('is-entering');
    }
    p.md.innerHTML = renderMarkdown(m.content);
    p.md.classList.toggle('is-streaming', streaming);
  }

  if (streaming) return;

  // terminal state: notices, errors, actions (rebuilt once)
  p.extra?.remove();
  p.extra = h('div');
  if (m.notice) p.extra.append(h('div', { class: 'notice' }, m.notice));
  if (m.status === 'error') {
    const card = h('div', { class: 'error-card' },
      h('span', { class: 'ic', html: icon('alert') }),
      h('div', { class: 'body' }, m.error || 'Algo deu errado.', h('br'),
        h('button', { type: 'button', class: 'btn', onclick: () => emit('regenerate', { message: m }) },
          h('span', { class: 'ic', html: icon('retry') }), 'Tentar novamente')));
    p.extra.append(card);
  }
  el.append(p.extra);
  p.actions?.remove();
  p.actions = actionsFor(m);
  el.append(p.actions);
}

function actionsFor(m) {
  const a = h('div', { class: 'actions' });
  if (m.content) {
    const copy = iconBtn('copy', 'Copiar', () => copyWithFeedback(copy, m.content));
    a.append(copy);
  }
  a.append(iconBtn('retry', 'Regenerar', () => emit('regenerate', { message: m })));
  a.append(branchNav(m));
  const meta = h('span', { class: 'meta' });
  const modelBtn = h('button', { type: 'button', 'data-tip': 'Regenerar com outro modelo', style: { color: 'inherit' } }, prettyModel(m.model));
  modelBtn.addEventListener('click', () => {
    const models = allModels();
    openMenu({
      anchor: modelBtn, placement: 'top-start',
      items: [{ header: 'Regenerar com' }, ...models.map((x) => ({
        label: x.name, sub: x.provider.name, checked: x.ref === m.model,
        onSelect: () => emit('regenerate', { message: m, model: x.ref }),
      }))],
    });
  });
  meta.append(modelBtn);
  if (m.status === 'stopped') meta.append(h('span', { class: 'sep' }, '·'), 'Interrompido');
  const u = m.usage;
  if (u && (u.output || u.tps)) {
    const bits = [];
    if (u.output) bits.push(`${u.output.toLocaleString('pt-BR')} tokens`);
    if (u.tps) bits.push(`${u.tps.toLocaleString('pt-BR')} tok/s`);
    if (u.ttft_ms) bits.push(`${(u.ttft_ms / 1000).toFixed(1)}s até o 1º token`);
    meta.append(h('span', { class: 'stat' }, h('span', { class: 'sep' }, '·'), bits.join(' · ')));
  }
  a.append(meta);
  return a;
}

// ------------------------------------------------------------------ streaming

export function attachStream(id) {
  if (streams.has(id)) return;
  S.generating.add(id);
  const close = api.stream(id, {
    event(ev) {
      const m = S.current?.msgs.get(id);
      if (!m) return;
      switch (ev.type) {
        case 'snapshot': m.content = ev.content; m.reasoning = ev.reasoning; break;
        case 'text': m.content += ev.text; break;
        case 'reasoning': m.reasoning += ev.text; break;
        case 'reasoning_done': m.reasoning_ms = ev.ms; break;
        case 'reset': m.content = ''; m.reasoning = ''; m.reasoning_ms = null; break;
        case 'notice': m.notice = (m.notice ? m.notice + ' ' : '') + ev.text; break;
        case 'done':
          Object.assign(m, ev.message);
          finish(id);
          break;
        case 'error':
          m.status = 'error';
          m.error = ev.message;
          finish(id);
          break;
        default: return;
      }
      schedule(id);
    },
    lost() {
      streams.delete(id);
      // server restarted or connection dropped: reload the message state
      setTimeout(() => emit('stream-lost', id), 800);
    },
  });
  streams.set(id, close);
  emit('generating', true);
}

function finish(id) {
  streams.get(id)?.();
  streams.delete(id);
  S.generating.delete(id);
  emit('generating', S.generating.size > 0);
  emit('stream-done', id);
}

export function detachAll() {
  for (const close of streams.values()) close();
  streams.clear();
  S.generating.clear();
  emit('generating', false);
}

function schedule(id) {
  dirty.add(id);
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(flush);
}

function flush(ts) {
  if (ts - lastFrame < 45) { requestAnimationFrame(flush); return; }
  lastFrame = ts;
  rafPending = false;
  for (const id of dirty) {
    const el = $(`.msg[data-id="${id}"]`, inner());
    const m = S.current?.msgs.get(id);
    if (el && m) updateAssistant(el, m);
  }
  dirty.clear();
  updateToBottom();
  updateRailSoon();
}

// ------------------------------------------------------------------ scroll affordances

export function updateToBottom() {
  const t = thread();
  const btn = $('#to-bottom');
  const last = inner().lastElementChild?.lastElementChild;
  if (!last || !t.clientHeight) { btn.classList.remove('is-visible'); return; }
  const below = last.getBoundingClientRect().bottom - t.getBoundingClientRect().bottom;
  btn.classList.toggle('is-visible', below > 40);
}

export function scrollToEnd(smooth = true) {
  const t = thread();
  const last = inner().lastElementChild?.lastElementChild;
  if (!last) return;
  const below = last.getBoundingClientRect().bottom - t.getBoundingClientRect().bottom + 32;
  t.scrollBy({ top: Math.max(0, below), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

// ------------------------------------------------------------------ rail (conversation map)

let railTimer;
function updateRailSoon() {
  clearTimeout(railTimer);
  railTimer = setTimeout(updateRail, 300);
}

export function updateRail() {
  const rail = $('#rail');
  const msgs = $$('.msg', inner());
  if (msgs.length < 6) { rail.classList.remove('is-visible'); rail.innerHTML = ''; return; }
  rail.classList.add('is-visible');
  if (rail.childElementCount !== msgs.length) {
    rail.innerHTML = '';
    for (const el of msgs) {
      const m = S.current?.msgs.get(el.dataset.id);
      const isUser = el.classList.contains('user');
      const len = (m?.content || '').length;
      const w = isUser ? 7 : Math.round(9 + Math.min(13, Math.log2(len / 80 + 1) * 3));
      const snippet = (m?.content || '').replace(/\s+/g, ' ').slice(0, 60) || (isUser ? 'Mensagem' : 'Resposta');
      const b = h('button', { type: 'button', class: isUser ? 'u' : 'a', style: { width: w + 'px' }, 'data-tip': snippet, 'aria-label': snippet });
      b.addEventListener('click', () => {
        const t = thread();
        t.scrollTo({ top: el.offsetTop - 12, behavior: reducedMotion() ? 'auto' : 'smooth' });
      });
      rail.append(b);
    }
  }
  railInView();
}

function railInView() {
  const rail = $('#rail');
  if (!rail.classList.contains('is-visible')) return;
  const t = thread().getBoundingClientRect();
  const msgs = $$('.msg', inner());
  const btns = rail.children;
  msgs.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    btns[i]?.classList.toggle('in-view', r.bottom > t.top + 20 && r.top < t.bottom - 20);
  });
}

export function initThread() {
  const t = thread();
  let ticking = false;
  t.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; updateToBottom(); railInView(); });
  }, { passive: true });
  $('#to-bottom').innerHTML = icon('arrow-down');
  $('#to-bottom').addEventListener('click', () => scrollToEnd(true));
  inner().addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-code]');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent || '';
    if (await copyText(code)) {
      btn.innerHTML = icon('check') + '<span>Copiado</span>';
      setTimeout(() => { btn.innerHTML = icon('copy') + '<span>Copiar</span>'; }, 1500);
    }
  });
  new ResizeObserver(() => {
    const a = $('.turn.is-anchor', inner());
    if (a) a.style.setProperty('--anchor-h', Math.max(0, t.clientHeight - 24) + 'px');
    updateToBottom();
  }).observe(t);
}

export function lastAssistantText() {
  const path = activePath();
  for (let i = path.length - 1; i >= 0; i--) if (path[i].role === 'assistant' && path[i].content) return path[i].content;
  return null;
}

export function lastUserMessage() {
  const path = activePath();
  for (let i = path.length - 1; i >= 0; i--) if (path[i].role === 'user') return path[i];
  return null;
}
