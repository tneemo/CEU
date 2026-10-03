// Popover menus, modal dialog shell, toasts and tooltips (port of web/js/ui.js).
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Ic } from "../lib/icons";
import { kbd as fmtKbd } from "../lib/util";
import { closeDialog, closeMenu, dismissToast, isPopoverOpen, useUi, type MenuItem, type Placement } from "../state/ui";

// ------------------------------------------------------------------ positioning

export function place(
  el: HTMLElement,
  { anchor, x = 0, y = 0, placement = "bottom-start", gap = 6 }: { anchor?: HTMLElement | null; x?: number; y?: number; placement?: Placement; gap?: number },
) {
  const vw = innerWidth, vh = innerHeight;
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y };
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let [side, align] = placement.split("-");
  if (side === "bottom" && r.bottom + gap + hgt > vh - 8 && r.top - gap - hgt > 8) side = "top";
  else if (side === "top" && r.top - gap - hgt < 8 && r.bottom + gap + hgt < vh - 8) side = "bottom";
  let top = side === "bottom" ? r.bottom + gap : r.top - gap - hgt;
  let left = align === "end" ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  top = Math.max(8, Math.min(top, vh - hgt - 8));
  el.style.left = left + "px";
  el.style.top = top + "px";
  el.classList.toggle("from-bottom", side === "top");
  el.style.setProperty("--origin", `${align === "end" ? "right" : "left"} ${side === "top" ? "bottom" : "top"}`);
}

// ------------------------------------------------------------------ keyboard list navigation

/** Keyboard-navigable list inside a container. Items are `.menu-item` / `.palette-item` elements. */
export function listNav(container: HTMLElement) {
  const items = () => Array.from(container.querySelectorAll<HTMLElement>(".menu-item:not(:disabled), .palette-item"));
  let idx = -1;
  const set = (i: number, scroll = true) => {
    const all = items();
    all.forEach((el) => el.classList.remove("is-active"));
    idx = all.length ? (i + all.length) % all.length : -1;
    if (idx >= 0) {
      all[idx].classList.add("is-active");
      if (scroll) all[idx].scrollIntoView({ block: "nearest" });
    }
  };
  const onMove = (e: MouseEvent) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>(".menu-item, .palette-item");
    if (!it) return;
    const i = items().indexOf(it);
    if (i !== idx) set(i, false);
  };
  container.addEventListener("mousemove", onMove);
  return {
    key(e: KeyboardEvent | React.KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === "ArrowDown") { e.preventDefault(); set(idx + 1); return true; }
      if (e.key === "ArrowUp") { e.preventDefault(); set(idx - 1); return true; }
      if (e.key === "Home" && tag !== "INPUT") { e.preventDefault(); set(0); return true; }
      if (e.key === "End" && tag !== "INPUT") { e.preventDefault(); set(items().length - 1); return true; }
      if (e.key === "Enter") {
        const it = items()[idx];
        if (it) { e.preventDefault(); it.click(); return true; }
      }
      return false;
    },
    set,
    destroy: () => container.removeEventListener("mousemove", onMove),
  };
}

// ------------------------------------------------------------------ menu

function MenuRow({ it }: { it: MenuItem }) {
  if (it === "sep") return <div className="menu-sep" />;
  if ("header" in it) return <div className="menu-h">{it.header}</div>;
  return (
    <button
      type="button"
      className={"menu-item" + (it.danger ? " danger" : "")}
      role="menuitem"
      disabled={it.disabled}
      onClick={() => {
        closeMenu();
        it.onSelect?.();
      }}
    >
      {it.icon && <Ic name={it.icon} />}
      <span className="lbl">
        {it.label}
        {it.sub && <span className="sub">{it.sub}</span>}
      </span>
      {(it.kbd || it.key) && <kbd>{it.key ? it.key.toUpperCase() : fmtKbd(it.kbd!)}</kbd>}
      {it.checked && <Ic name="check" className="check" />}
    </button>
  );
}

export function MenuLayer() {
  const menu = useUi((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    place(el, menu);
    const nav = listNav(el);
    el.focus();
    requestAnimationFrame(() => nav.set(0));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        menu.anchor?.focus?.();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const hit = menu.items.find(
          (it): it is Extract<MenuItem, { label: string }> => !!it && typeof it === "object" && "label" in it && it.key?.toLowerCase() === e.key.toLowerCase() && !it.disabled,
        );
        if (hit) {
          e.preventDefault();
          closeMenu();
          hit.onSelect?.();
          return;
        }
      }
      nav.key(e);
    };
    const outside = (e: PointerEvent) => {
      if (el.contains(e.target as Node) || menu.anchor?.contains(e.target as Node)) return;
      closeMenu();
    };
    // an anchored menu would float away from its button when what's behind it scrolls
    const onScroll = (e: Event) => {
      if (menu.anchor && e.target instanceof Node && !el.contains(e.target) && e.target.contains(menu.anchor)) closeMenu();
    };
    el.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    const t = setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
    return () => {
      clearTimeout(t);
      nav.destroy();
      el.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", outside, true);
      if (document.activeElement === document.body || !document.activeElement) prevFocus?.focus?.();
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} key={menu.id} className={"menu " + (menu.className || "")} tabIndex={-1} role="menu">
      {menu.items.filter(Boolean).map((it, i) => (
        <MenuRow key={i} it={it as MenuItem} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ dialog shell

export function DialogShell({ id, className, label, children }: { id: number; className: string; label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const prev = document.activeElement as HTMLElement | null;
    (el.querySelector<HTMLElement>("[autofocus]") || el).focus();
    return () => {
      if (prev && document.contains(prev)) prev.focus?.();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !isPopoverOpen()) {
      e.preventDefault();
      e.stopPropagation();
      closeDialog(id);
    }
    if (e.key === "Tab") {
      const f = Array.from(ref.current!.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')).filter(
        (x) => !(x as HTMLButtonElement).disabled && x.offsetParent,
      );
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <>
      <div className="backdrop" onPointerDown={() => closeDialog(id)} />
      <div ref={ref} className={"dialog " + className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </>
  );
}

export function ConfirmDialog({ id, title, body, confirm, danger, resolve }: { id: number; title: string; body: ReactNode; confirm: string; danger: boolean; resolve: (v: boolean) => void }) {
  const answer = (v: boolean) => {
    useUi.setState((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) }));
    resolve(v);
  };
  return (
    <DialogShell id={id} className="confirm">
      <h3>{title}</h3>
      <p>{body}</p>
      <div className="row">
        <button className="btn ghost" type="button" onClick={() => answer(false)}>
          Cancelar
        </button>
        <button className={"btn " + (danger ? "danger" : "primary")} type="button" autoFocus onClick={() => answer(true)}>
          {confirm}
        </button>
      </div>
    </DialogShell>
  );
}

// ------------------------------------------------------------------ toasts

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={"toast" + (t.action ? "" : " plain") + (t.leaving ? " is-leaving" : "")}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.fn();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ tooltips (delegated via data-tip / data-kbd)

export function Tooltip() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tip = ref.current!;
    let timer: ReturnType<typeof setTimeout>;
    let target: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      tip.classList.remove("is-visible");
      target = null;
    };
    const over = (e: PointerEvent) => {
      const t = (e.target as HTMLElement).closest?.<HTMLElement>("[data-tip]") ?? null;
      if (t === target) return;
      hide();
      if (!t || e.pointerType === "touch") return;
      // sidebar items carry their label; the tip only names them in the collapsed rail
      const rail = t.dataset.tipRail != null;
      if (rail && document.documentElement.dataset.sidebar !== "closed") return;
      target = t;
      timer = setTimeout(() => {
        if (!document.contains(t) || t.getAttribute("aria-expanded") === "true") return;
        tip.textContent = t.dataset.tip || "";
        if (t.dataset.kbd) {
          const k = document.createElement("kbd");
          k.textContent = fmtKbd(t.dataset.kbd);
          tip.append(k);
        }
        const r = t.getBoundingClientRect();
        tip.style.left = "0px";
        tip.style.top = "0px";
        const w = tip.offsetWidth;
        let top = r.bottom + 6;
        if (top + 30 > innerHeight) top = r.top - 30;
        let left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6));
        if (rail) {
          left = r.right + 8;
          top = r.top + r.height / 2 - tip.offsetHeight / 2;
        }
        tip.style.left = left + "px";
        tip.style.top = top + "px";
        tip.classList.add("is-visible");
      }, 450);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      removeEventListener("blur", hide);
    };
  }, []);
  return <div ref={ref} className="tooltip" role="tooltip" />;
}
