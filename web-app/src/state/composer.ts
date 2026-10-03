// Composer state: text, attachments and per-conversation drafts (port of web/js/composer.js).
import { create } from "zustand";
import { api, type Attachment, type CallSpec } from "../api";
import { store } from "../lib/util";
import { S } from "./store";
import { toast } from "./ui";

export interface PendingAtt {
  localId: number;
  id?: string;
  name: string;
  mime: string;
  size: number;
  status: "uploading" | "ready" | "error";
  preview: string | null;
  error?: string;
}

interface ComposerState {
  text: string;
  atts: PendingAtt[];
  /** `@modelo` / `@Code` / `@Agent`: who the next message is for (structured, never parsed from the text) */
  call: CallSpec | null;
}

export const useComposer = create<ComposerState>(() => ({ text: "", atts: [], call: null }));

export function setCall(call: CallSpec | null) {
  useComposer.setState({ call });
}

let seq = 0;
const draftKey = () => "draft:" + (S().current?.conv.id || "new");

export const composerInput = { el: null as HTMLTextAreaElement | null };

export function setText(text: string) {
  useComposer.setState({ text });
  if (text) store.set(draftKey(), text);
  else store.del(draftKey());
}

export function canSend() {
  const { text, atts, call } = useComposer.getState();
  // a bare mention is a message too: "your turn" for the model called
  return (text.trim().length > 0 || atts.length > 0 || !!call) && atts.every((a) => a.status === "ready");
}

export function outgoing(): { content: string; attachments: Attachment[] } {
  const { text, atts } = useComposer.getState();
  return { content: text, attachments: atts.map((a) => ({ id: a.id!, name: a.name, mime: a.mime, size: a.size })) };
}

/** Called once the message was accepted by the server. `key` is the draft slot the text came from. */
export function clearComposer(key = draftKey()) {
  useComposer.getState().atts.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
  useComposer.setState({ text: "", atts: [], call: null });
  store.del(key);
}

export const currentDraftKey = draftKey;

/** Swap drafts when the open conversation changes. */
export function loadDraft() {
  useComposer.getState().atts.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
  useComposer.setState({ text: store.get(draftKey(), "") || "", atts: [], call: null });
}

export function focusComposer() {
  if (matchMedia("(max-width: 760px)").matches) return;
  const el = composerInput.el;
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

// ------------------------------------------------------------------ attachments

const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|lua|sh|bash|zsh|ps1|bat|cmd|sql|ya?ml|toml|ini|cfg|conf|env|log|tex|r|scala|dart|vue|svelte|gradle|dockerfile|makefile|gitignore)$/i;

function patchAtt(localId: number, patch: Partial<PendingAtt>) {
  useComposer.setState((s) => ({ atts: s.atts.map((a) => (a.localId === localId ? { ...a, ...patch } : a)) }));
}

export function addFiles(files: File[]) {
  for (const file of files) {
    const mime = file.type || (TEXT_EXT.test(file.name) ? "text/plain" : "");
    const ok =
      mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("text/") || TEXT_EXT.test(file.name) || /json|xml|javascript|yaml|csv/.test(mime);
    if (!ok) {
      toast(`“${file.name}” não é suportado. Anexe texto, código, imagens ou PDF.`);
      continue;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast(`“${file.name}” passa de 25 MB.`);
      continue;
    }
    const a: PendingAtt = {
      localId: ++seq,
      name: file.name || "imagem-colada.png",
      mime: mime || "text/plain",
      size: file.size,
      status: "uploading",
      preview: mime.startsWith("image/") ? URL.createObjectURL(file) : null,
    };
    useComposer.setState((s) => ({ atts: [...s.atts, a] }));
    api
      .upload(file)
      .then((res) => patchAtt(a.localId, { id: res.id, mime: res.mime, status: "ready" }))
      .catch((err) => patchAtt(a.localId, { status: "error", error: err.message }));
  }
  composerInput.el?.focus();
}

export function removeAtt(localId: number) {
  const a = useComposer.getState().atts.find((x) => x.localId === localId);
  if (a?.preview) URL.revokeObjectURL(a.preview);
  useComposer.setState((s) => ({ atts: s.atts.filter((x) => x.localId !== localId) }));
  composerInput.el?.focus();
}
