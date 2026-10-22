import { useSyncExternalStore } from "react";
import en from "../locales/en.json";
import metadataEn from "../locales/metadata.en.json";

export type Language = "en" | "pt-BR";
export type LanguageSetting = Language | "auto";
const messages = { ...en, ...metadataEn };
type MessageKey = keyof typeof messages;

// Match only application-owned server templates. Captures (paths, queries, commit messages)
// are copied verbatim and are never translated or interpolated a second time.
const labelTemplates = Object.entries(metadataEn).filter(([key]) => /\{\d+\}/.test(key)).map(([key, translation]) => {
  const params: string[] = [];
  const pattern = key.split(/(\{\d+\})/).map((part) => {
    if (/^\{\d+\}$/.test(part)) { params.push(part); return "([\\s\\S]*?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return { pattern: new RegExp("^" + pattern + "$"), params, translation };
});

/** English is the default, including the old, previously inactive `auto` setting. */
export const resolveLanguage = (value: unknown): Language => value === "pt-BR" ? "pt-BR" : "en";

function initialLanguage(): Language {
  try { return resolveLanguage(localStorage.getItem("ceu:language")); }
  catch { return "en"; }
}

let language = initialLanguage();
const listeners = new Set<() => void>();
export const getLanguage = () => language;
export const getLocale = () => language === "en" ? "en-US" : "pt-BR";

export function setLanguage(value: LanguageSetting) {
  const next = resolveLanguage(value);
  document.documentElement.lang = next;
  try { localStorage.setItem("ceu:language", next); } catch { /* storage unavailable */ }
  if (next === language) return;
  language = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Subscribe at component boundaries so switching language preserves mounted UI state. */
export const useLanguage = () => useSyncExternalStore(subscribe, getLanguage);

/** Portuguese source phrases are stable message keys; interpolation never rescans user values. */
export function tr(key: MessageKey, ...values: (string | number | null | undefined)[]): string {
  const text = language === "pt-BR" ? key : messages[key];
  return text.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
}

/** For application-owned labels received from the server. Never apply to conversation content. */
export function translateLabel(text: string): string {
  if (language === "pt-BR") return text;
  if (Object.hasOwn(messages, text)) return messages[text as MessageKey];
  if (text.startsWith("Falta ")) {
    const suffix = " — o CEU pode instalar";
    const missing = text.slice(6, text.endsWith(suffix) ? -suffix.length : undefined);
    return tr("Falta {0}", missing.split(" e ").map(translateLabel).join(tr(" e "))) + (text.endsWith(suffix) ? tr(suffix) : "");
  }
  for (const prefix of ["Não encontrado. Instalador oficial (PowerShell): ", "Não encontrado. Instalação oficial: "] as const) {
    if (text.startsWith(prefix)) return messages[prefix] + text.slice(prefix.length);
  }
  for (const { pattern, params, translation } of labelTemplates) {
    const match = pattern.exec(text);
    if (match) return translation.replace(/\{\d+\}/g, (param) => match[params.indexOf(param) + 1]);
  }
  return text;
}
