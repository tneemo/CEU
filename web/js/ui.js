import { $, h, kbd as fmtKbd } from './util.js';
import { icon } from './icons.js';

const layer = () => $('#layer');

// ------------------------------------------------------------------ positioning

function place(el, { anchor, x, y, placement = 'bottom-start', gap = 6 }) {
  const vw = innerWidth, vh = innerHeight;
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let [side, align] = placement.split('-');
  if (side === 'bottom' && r.bottom + gap + hgt > vh - 8 && r.top - gap - hgt > 8) side = 'top';
  else if (side === 'top' && r.top - gap - hgt < 8 && r.bottom + gap + hgt < vh - 8) side = 'bottom';
  let top = side === 'bottom' ? r.bottom + gap : r.top - gap - hgt;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  top = Math.max(8, Math.min(top, vh - hgt - 8));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.classList.toggle('from-bottom', side === 'top');
  el.style.setProperty('--origin', `${align === 'end' ? 'right' : 'left'} ${side === 'top' ? 'bottom' : 'top'}`);
}

// ------------------------------------------------------------------ popovers

let current = null;

export function closePopover() {
  if (!current) return;
  const c = current;
  current = null;
  c.el.remove();
  document.removeEventListener('pointerdown', c.outside, true);
  c.anchor?.setAttribute?.('aria-expanded', 'false');
  c.onClose?.();
  if (c.restoreFocus && document.activeElement === document.body) c.restoreFocus.focus?.();
}

export function isPopoverOpen() { return !!current; }

export function openPopover({ anchor, x, y, placement, className = '', build, onClose, focus = true }) {
  closePopover();
  const el = h('div', { class: 'menu ' + className, tabindex: '-1', role: 'menu' });
  build(el);
  layer().append(el);
  place(el, { anchor, x, y, placement });
  const outside = (e) => {
    if (el.contains(e.target) || anchor?.contains?.(e.target)) return;
    closePopover();
  };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  current = { el, anchor, outside, onClose, restoreFocus: document.activeElement };
  anchor?.setAttribute?.('aria-expanded', 'true');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); anchor?.focus?.(); }
  });
  if (focus) (el.querySelector('[autofocus]') || el).focus();
  return { el, close: closePopover, reposition: () => place(el, { anchor, x, y, placement }) };
}

/** Keyboard-navigable list inside a container. Items are elements with .menu-item. */
export function listNav(container, { onEnter } = {}) {
  const items = () => Array.from(container.querySelectorAll('.menu-item:not(:disabled), .palette-item'));
  let idx = -1;
  const set = (i, scroll = true) => {
    const all = items();
    all.forEach((el) => el.classList.remove('is-active'));
    idx = all.length ? (i + all.length) % all.length : -1;
    if (idx >= 0) {
      all[idx].classList.add('is-active');
      if (scroll) all[idx].scrollIntoView({ block: 'nearest' });
    }
  };
  container.addEventListener('mousemove', (e) => {
    const it = e.target.closest('.menu-item, .palette-item');
    if (!it) return;
    const i = items().indexOf(it);
    if (i !== idx) set(i, false);
  });
  return {
    key(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); set(idx + 1); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); set(idx - 1); return true; }
      if (e.key === 'Home' && e.target.tagName !== 'INPUT') { e.preventDefault(); set(0); return true; }
      if (e.key === 'End' && e.target.tagName !== 'INPUT') { e.preventDefault(); set(items().length - 1); return true; }
      if (e.key === 'Enter') {
        const it = items()[idx];
        if (it) { e.preventDefault(); onEnter ? onEnter(it, e) : it.click(); return true; }
      }
      return false;
    },
    set,
    reset() { set(0); },
    get index() { return idx; },
  };
}

export function menuItem(it) {
  if (it === 'sep') return h('div', { class: 'menu-sep' });
  if (it.header) return h('div', { class: 'menu-h' }, it.header);
  const btn = h('button', { type: 'button', class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', disabled: it.disabled });
  btn.innerHTML = (it.icon ? `<span class="ic">${icon(it.icon)}</span>` : '') +
    `<span class="lbl"></span>` +
    (it.kbd ? `<kbd>${fmtKbd(it.kbd)}</kbd>` : '') +
    (it.checked ? `<span class="ic check">${icon('check')}</span>` : '');
  const lbl = btn.querySelector('.lbl');
  lbl.textContent = it.label;
  if (it.sub) lbl.append(h('span', { class: 'sub' }, it.sub));
  btn.addEventListener('click', () => { closePopover(); it.onSelect?.(); });
  return btn;
}

export function openMenu({ anchor, x, y, placement, items, className = '', onClose }) {
  return openPopover({
    anchor, x, y, placement, className, onClose,
    build(el) {
      items.filter(Boolean).forEach((it) => el.append(menuItem(it)));
      const nav = listNav(el);
      el.addEventListener('keydown', (e) => nav.key(e));
      requestAnimationFrame(() => nav.set(0));
    },
  });
}

// ------------------------------------------------------------------ dialogs

let dialogStack = [];

export function openDialog(el, { onClose, backdropClose = true } = {}) {
  const backdrop = h('div', { class: 'backdrop' });
  const prev = document.activeElement;
  const close = () => {
    backdrop.remove();
    el.remove();
    dialogStack = dialogStack.filter((d) => d.el !== el);
    if (!dialogStack.length) $('#app').inert = false;
    onClose?.();
    if (prev && document.contains(prev)) prev.focus?.();
    else dialogStack[dialogStack.length - 1]?.el.focus();
  };
  if (backdropClose) backdrop.addEventListener('pointerdown', close);
  el.classList.add('dialog');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.tabIndex = -1;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !isPopoverOpen()) { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const f = Array.from(el.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')).filter((x) => !x.disabled && x.offsetParent);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  closePopover();
  layer().append(backdrop, el);
  dialogStack.push({ el, close });
  // Everything behind a modal is inert: no focus, no typing into the composer.
  $('#app').inert = true;
  (el.querySelector('[autofocus]') || el).focus();
  return close;
}

export function isDialogOpen() { return dialogStack.length > 0; }
export function closeTopDialog() { dialogStack[dialogStack.length - 1]?.close(); }

export function confirmDialog({ title, body, confirm = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const el = h('div', { class: 'confirm' },
      h('h3', {}, title),
      h('p', {}, body),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Cancelar'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', autofocus: true, onclick: () => { result = true; close(); } }, confirm)));
    const close = openDialog(el, { onClose: () => resolve(result) });
  });
}

// ------------------------------------------------------------------ toasts

export function toast(message, { action, duration = 4200 } = {}) {
  const el = h('div', { class: 'toast' + (action ? '' : ' plain') }, h('span', {}, message));
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    el.append(h('button', { type: 'button', onclick: () => { action.fn(); dismiss(); } }, action.label));
  }
  $('#toasts').append(el);
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

// ------------------------------------------------------------------ tooltips

export function initTooltips() {
  const tip = $('#tooltip');
  let timer, target;
  const hide = () => { clearTimeout(timer); tip.classList.remove('is-visible'); target = null; };
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t === target) return;
    hide();
    if (!t || e.pointerType === 'touch') return;
    target = t;
    timer = setTimeout(() => {
      if (!document.contains(t) || t.getAttribute('aria-expanded') === 'true') return;
      tip.innerHTML = '';
      tip.append(t.dataset.tip);
      if (t.dataset.kbd) tip.append(h('kbd', {}, fmtKbd(t.dataset.kbd)));
      const r = t.getBoundingClientRect();
      tip.style.left = '0px';
      tip.style.top = '0px';
      const w = tip.offsetWidth;
      let top = r.bottom + 6;
      if (top + 30 > innerHeight) top = r.top - 30;
      tip.style.left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6)) + 'px';
      tip.style.top = top + 'px';
      tip.classList.add('is-visible');
    }, 450);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  addEventListener('blur', hide);
}
