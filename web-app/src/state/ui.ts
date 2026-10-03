// Overlay layer state: popover menus, modal dialogs and toasts (port of web/js/ui.js).
import type { ReactNode } from "react";
import { create } from "zustand";

export type MenuItem =
  | "sep"
  | { header: string }
  | {
      label: string;
      sub?: string;
      icon?: string;
      kbd?: string;
      /** single-letter accelerator while the menu is open (shown as the kbd hint) */
      key?: string;
      danger?: boolean;
      checked?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
    };

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

export interface MenuSpec {
  anchor?: HTMLElement | null;
  x?: number;
  y?: number;
  placement?: Placement;
  items: (MenuItem | null | false)[];
  className?: string;
  onClose?: () => void;
}

export type DialogSpec =
  | { id: number; kind: "palette" }
  | { id: number; kind: "settings"; section: string; focus?: string }
  /** create (agentId null) or edit an agent */
  | { id: number; kind: "agent"; agentId: string | null }
  /** create (convId null) or edit a Room */
  | { id: number; kind: "room"; convId: string | null }
  | {
      id: number;
      kind: "confirm";
      title: string;
      body: ReactNode;
      confirm: string;
      danger: boolean;
      resolve: (v: boolean) => void;
    };

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; fn: () => void };
  leaving?: boolean;
}

interface UiState {
  menu: (MenuSpec & { id: number }) | null;
  dialogs: DialogSpec[];
  toasts: Toast[];
  dropping: boolean;
}

export const useUi = create<UiState>(() => ({ menu: null, dialogs: [], toasts: [], dropping: false }));

let seq = 0;

// ------------------------------------------------------------------ menus

export function openMenu(spec: MenuSpec) {
  closeMenu();
  spec.anchor?.setAttribute("aria-expanded", "true");
  useUi.setState({ menu: { ...spec, id: ++seq } });
}

export function closeMenu() {
  const m = useUi.getState().menu;
  if (!m) return;
  useUi.setState({ menu: null });
  m.anchor?.setAttribute("aria-expanded", "false");
  m.onClose?.();
}

export const isPopoverOpen = () => !!useUi.getState().menu || !!document.querySelector("[data-popover-open]");

// ------------------------------------------------------------------ dialogs

type DialogInput =
  | { kind: "palette" }
  | { kind: "settings"; section: string; focus?: string }
  | { kind: "agent"; agentId: string | null }
  | { kind: "room"; convId: string | null }
  | Omit<Extract<DialogSpec, { kind: "confirm" }>, "id">;

export function openDialog(d: DialogInput) {
  closeMenu();
  const spec = { ...d, id: ++seq } as DialogSpec;
  useUi.setState((s) => ({ dialogs: [...s.dialogs, spec] }));
  return spec.id;
}

export function closeDialog(id: number) {
  const d = useUi.getState().dialogs.find((x) => x.id === id);
  if (!d) return;
  useUi.setState((s) => ({ dialogs: s.dialogs.filter((x) => x.id !== id) }));
  if (d.kind === "confirm") d.resolve(false);
}

export const isDialogOpen = () => useUi.getState().dialogs.length > 0;

export function closeTopDialog() {
  const ds = useUi.getState().dialogs;
  if (ds.length) closeDialog(ds[ds.length - 1].id);
}

export function confirmDialog(o: { title: string; body: ReactNode; confirm?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => {
    openDialog({ kind: "confirm", title: o.title, body: o.body, confirm: o.confirm || "Confirmar", danger: !!o.danger, resolve });
  });
}

export function openPalette() {
  if (useUi.getState().dialogs.some((d) => d.kind === "palette")) return;
  openDialog({ kind: "palette" });
}

/** `focus`: an item to open inside the section (e.g. one integration of the runtimes hub). */
export function openSettings(section = "general", focus?: string) {
  const existing = useUi.getState().dialogs.find((d) => d.kind === "settings");
  if (existing) useUi.setState((s) => ({ dialogs: s.dialogs.map((d) => (d.id === existing.id ? { ...d, section, focus } : d)) }));
  else openDialog({ kind: "settings", section, focus });
}

// ------------------------------------------------------------------ toasts

export function toast(message: string, { action, duration = 4200 }: { action?: Toast["action"]; duration?: number } = {}) {
  const id = ++seq;
  useUi.setState((s) => ({ toasts: [...s.toasts, { id, message, action }] }));
  const timer = setTimeout(() => dismissToast(id), duration);
  return () => {
    clearTimeout(timer);
    dismissToast(id);
  };
}

export function dismissToast(id: number) {
  useUi.setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 200);
}
