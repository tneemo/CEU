import { tr, useLanguage } from "../lib/i18n";
// Participants of a conversation (calls: `@modelo`, `@Code`, `@Agent`). A participant is the model
// itself, never a persona: it is shown by its own name and a small geometric glyph that stays the
// same for that model everywhere, so several voices in one thread can be told apart at a glance.
// Delegated work is shown by the surface it ran on ("Code · pasta", "Agent · nome").
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { participantLabel, participantName, type Target } from "../lib/mention";
import { useApp } from "../state/store";
import "./Participant.css";

/** A participant's display name, from its ref. */
export function Name({ model }: { model: string | null | undefined }) {
  useLanguage();
  return <>{useApp((s) => participantLabel(model, s))}</>;
}

// outlines on a 12×12 grid; picked by a stable hash of the model ref
const SHAPES = [
  <rect key="0" x="2.5" y="2.5" width="7" height="7" />,
  <polygon key="1" points="6,1.5 10.5,6 6,10.5 1.5,6" />,
  <polygon key="2" points="6,1.8 10.6,10 1.4,10" />,
  <circle key="3" cx="6" cy="6" r="4.2" />,
  <polygon key="4" points="6,1.4 10,3.7 10,8.3 6,10.6 2,8.3 2,3.7" />,
  <polygon key="5" points="2,2.5 10,2.5 6,10" />,
  <path key="6" d="M6 1.5v9M1.5 6h9" />,
];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// surfaces work is delegated to: a solid (Code) and a dot in its orbit (Agent), filled to read as places
const SURFACES: Record<string, JSX.Element> = {
  code: <path d="M6 1.3 10.4 3.8v4.4L6 10.7 1.6 8.2V3.8ZM1.6 3.8 6 6.3l4.4-2.5M6 6.3v4.4" />,
  agent: (
    <>
      <circle cx="6" cy="6" r="1.7" fill="currentColor" />
      <circle cx="6" cy="6" r="4.4" strokeDasharray="2.2 1.6" />
    </>
  ),
};

export function ModelGlyph({ model }: { model: string | null | undefined }) {
  useLanguage();
  const surface = model?.match(/^(code|agent):/)?.[1];
  const shape = surface ? SURFACES[surface] : SHAPES[hash(model || "") % SHAPES.length];
  return (
    <svg className="glyph" viewBox="0 0 12 12" aria-hidden="true">
      {shape}
    </svg>
  );
}

function TargetRow({ t, active, i, onPick, onHover }: { t: Target; active: boolean; i: number; onPick: (t: Target) => void; onHover: (i: number) => void }) {
  useLanguage();
  const glyph = t.kind === "model" ? t.m.ref : t.kind === "code" ? "code:" : "agent:";
  const label = t.kind === "model" ? participantName(t.m.name) : t.kind === "code" ? (t.path ? `Code · ${t.name}` : tr("Code · escolher pasta…")) : `Agent · ${t.a.name}`;
  const sub = t.kind === "model" ? t.m.provider.name : t.kind === "code" ? t.path || tr("Uma sessão de Code nessa pasta") : tr("Uma tarefa do agente");
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={"menu-item mention-row" + (active ? " is-active" : "")}
      // keep the caret in the textarea
      onPointerDown={(e) => e.preventDefault()}
      onPointerEnter={() => onHover(i)}
      onClick={() => onPick(t)}
    >
      <ModelGlyph model={glyph} />
      <span className="lbl" title={t.kind === "model" ? t.m.name : label}>
        {label}
      </span>
      <span className="sub" title={sub}>
        {sub}
      </span>
    </button>
  );
}

/** Suggestions while typing `@` in the composer: models answer here; surfaces get the work delegated.
 * Focus stays in the textarea; the composer drives the keys. */
export function MentionMenu({ items, active, onPick, onHover }: { items: Target[]; active: number; onPick: (t: Target) => void; onHover: (i: number) => void }) {
  useLanguage();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const firstSurface = items.findIndex((t) => t.kind !== "model");
  return (
    <div className="mention-menu menu" role="listbox" aria-label={tr("Chamar um modelo ou delegar a uma área do CEU")} ref={ref}>
      {items.map((t, i) => (
        <div key={t.key} role="presentation">
          {i === 0 && t.kind === "model" && <div className="menu-h">{tr("Responder aqui")}</div>}
          {i === firstSurface && <div className="menu-h">{tr("Delegar · o resultado volta para cá")}</div>}
          <TargetRow t={t} i={i} active={i === active} onPick={onPick} onHover={onHover} />
        </div>
      ))}
    </div>
  );
}
