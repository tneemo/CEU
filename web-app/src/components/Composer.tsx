import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { autosize, cx, extOf, formatSize, isMobile, kbd } from "../lib/util";
import { api } from "../api";
import { canCall, canDelegate, editLast, isAgentic, isCodeSession, loadHomeSuggestions, pickProject, send, setEffort, setModel, setPermissionMode, setProject, setRuntime, stop, view } from "../state/actions";
import { addFiles, canSend, composerInput, focusComposer, removeAtt, setCall, setText, useComposer } from "../state/composer";
import { allModels, currentRuntime, providersFor, runtimeModel, selectedEffort, useApp } from "../state/store";
import type { CallSpec, RuntimeInfo } from "../api";
import { openMenu, openSettings, toast } from "../state/ui";
import { MODES, modeInfo, RUNTIME_STATUS } from "./Code";
import { STATE_LABEL } from "./Runtimes";
import { ModelPicker } from "./ModelPicker";
import { MentionMenu, ModelGlyph } from "./Participant";
import { callOf, folderOf, matchModels, matchSurfaces, mentionAt, participantLabel, refOfCall, type Target } from "../lib/mention";

export const folderName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** Permission mode of the code session (or of the one about to start). */
function ModeButton() {
  const mode = useApp((s) => (s.current ? s.current.conv.permission_mode : s.pendingMode));
  const rt = useApp((s) => currentRuntime(s));
  const info = modeInfo(mode);
  return (
    <button
      type="button"
      className={"mode-btn mode-" + info.id}
      data-tip="Modo de permissão"
      aria-label={`Modo de permissão: ${info.label}`}
      onClick={(e) =>
        openMenu({
          anchor: e.currentTarget,
          placement: "top-start",
          items: [
            { header: "Modo" },
            ...MODES.filter((m) => rt.modes.includes(m.id)).map((m, i) => ({
              label: m.label,
              sub: rt.mode_notes[m.id] || m.sub,
              icon: m.icon,
              key: String(i + 1),
              checked: m.id === info.id,
              onSelect: () => setPermissionMode(m.id),
            })),
          ],
        })
      }
    >
      <Icon name={info.icon} />
      <span>{info.label}</span>
    </button>
  );
}

async function projectMenu(anchor: HTMLElement) {
  let recents: Awaited<ReturnType<typeof api.projects>> = [];
  try {
    recents = await api.projects();
  } catch (e: any) {
    toast(e.message);
  }
  const cur = useApp.getState().pendingProject;
  openMenu({
    anchor,
    placement: "top-start",
    items: [
      recents.length ? { header: "Recentes" } : null,
      ...recents.map((r) => ({
        label: r.name,
        sub: r.exists ? r.project_path : "Pasta não encontrada",
        icon: "archive",
        disabled: !r.exists,
        checked: r.project_path === cur,
        onSelect: () => setProject(r.project_path),
      })),
      recents.length ? ("sep" as const) : null,
      { label: "Escolher pasta…", icon: "new", onSelect: () => pickProject() },
    ],
  });
}

const FAMILY_ORDER: { family: RuntimeInfo["family"]; label: string }[] = [
  { family: "ceu_sdk", label: "CEU SDK" },
  { family: "codex_sdk", label: "Codex SDK" },
  { family: "claude_sdk", label: "Claude SDK" },
  { family: "redir", label: "CEU REDIR · agentes externos" },
];

function runtimeSub(r: RuntimeInfo) {
  if (r.status === "ready") return r.detail;
  if (r.integration) return `${STATE_LABEL[r.integration.state]} · ${r.detail}`;
  return r.status === "planned" ? r.detail : `${RUNTIME_STATUS[r.status]} · ${r.detail}`;
}

function runtimeMenu(anchor: HTMLElement, runtimes: RuntimeInfo[], current: string) {
  openMenu({
    anchor,
    placement: "top-start",
    items: [
      ...FAMILY_ORDER.flatMap(({ family, label }) => {
        const list = runtimes.filter((r) => r.family === family);
        if (!list.length) return [];
        return [
          { header: label },
          ...list.map((r) => ({
            label: family === "redir" || r.name !== label ? r.name : label,
            sub: runtimeSub(r),
            icon: family === "redir" ? "external" : "cube",
            checked: r.id === current,
            // not connected yet: picking it opens its setup in the hub instead
            disabled: r.status === "planned",
            onSelect: () => (r.status === "ready" ? setRuntime(r.id) : r.integration ? openSettings("runtimes", r.integration.id) : undefined),
          })),
        ];
      }),
      "sep" as const,
      { label: "Configurar runtimes e agentes…", icon: "settings", onSelect: () => openSettings("runtimes") },
    ],
  });
}

/** The chosen runtime can't run right now (logged out, uninstalled…): say why, offer setup. */
function RuntimeNotice() {
  const rt = useApp((s) => (!s.current && s.pendingKind === "code" ? currentRuntime(s) : null));
  if (!rt || rt.status === "ready") return null;
  return (
    <div className="runtime-notice" role="status">
      <Icon name="alert" />
      <span>
        <b>{rt.name}</b> {rt.integration ? `${STATE_LABEL[rt.integration.state].toLowerCase()}: ` : ""}
        {rt.detail}
      </span>
      {rt.integration && (
        <button type="button" className="btn" onClick={() => openSettings("runtimes", rt.integration!.id)}>
          {rt.integration.state === "unconfigured" ? "Configurar" : "Conectar"}
        </button>
      )}
    </div>
  );
}

/** Empty code session: which harness runs it. */
function RuntimeChip() {
  const runtimes = useApp((s) => s.runtimes);
  const rt = useApp((s) => currentRuntime(s));
  if (!runtimes.length) return null;
  return (
    <button type="button" className={cx("project-chip runtime-chip", rt.status !== "ready" && "is-unavailable")} data-tip="Runtime: quem executa a sessão" onClick={(e) => runtimeMenu(e.currentTarget, runtimes, rt.id)}>
      <Icon name={rt.family === "redir" ? "external" : "cube"} />
      <span className="n">{rt.family === "redir" ? `REDIR · ${rt.name}` : rt.name}</span>
      <Icon name="chevron-down" />
    </button>
  );
}

/** Empty code session: which folder the agent will work in, and which runtime. */
function ProjectChip() {
  const project = useApp((s) => s.pendingProject);
  return (
    <>
    <RuntimeNotice />
    <div className="project-row">
      <RuntimeChip />
      <button type="button" className={"project-chip" + (project ? "" : " is-empty")} onClick={(e) => (project ? projectMenu(e.currentTarget) : pickProject())}>
        <Icon name="archive" />
        <span className="n">{project ? folderName(project) : "Escolher pasta do projeto…"}</span>
        {project && <span className="p">{project}</span>}
        <Icon name="chevron-down" />
      </button>
    </div>
    </>
  );
}

function Attachments() {
  const atts = useComposer((s) => s.atts);
  if (!atts.length) return null;
  return (
    <div className="attachments">
      {atts.map((a) => (
        <div key={a.localId} className={cx("chip", a.status === "uploading" && "is-uploading", a.status === "error" && "is-error")} title={a.error || a.name}>
          {a.preview ? <img className="thumb" src={a.preview} alt="" /> : <span className="fi">{extOf(a.name).slice(0, 4)}</span>}
          <span className="meta">
            <span className="n">{a.name}</span>
            <span className="s">{a.status === "uploading" ? "Enviando…" : a.status === "error" ? a.error : formatSize(a.size)}</span>
          </span>
          <button type="button" className="x" aria-label={`Remover ${a.name}`} onClick={() => removeAtt(a.localId)}>
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** `@` chosen: the next message goes to that model (it answers here as a participant), or is
 * delegated to Code / an Agent (the work runs there and the result comes back here). */
function CallChip({ call }: { call: CallSpec }) {
  const ref = refOfCall(call)!;
  const name = useApp((s) => participantLabel(ref, s));
  const delegated = call.surface !== "chat";
  const tip = delegated
    ? call.surface === "code"
      ? `Uma sessão de Code em ${call.target} recebe o pedido e o contexto desta conversa; o resultado volta para cá`
      : `${name.replace("Agent · ", "")} recebe o pedido e o contexto desta conversa como uma tarefa; o resultado volta para cá`
    : `${name} responde a esta mensagem, nesta conversa, vendo o que já foi dito`;
  return (
    <div className="call-row">
      <span className={cx("call-chip", delegated && "is-delegated")} data-tip={tip}>
        <ModelGlyph model={ref} />
        <span>{delegated ? "Delegar a" : "Para"}</span>
        <b>{name}</b>
        <button type="button" className="x" aria-label={`Não chamar ${name}`} onClick={() => (setCall(null), focusComposer())}>
          <Icon name="close" />
        </button>
      </span>
    </div>
  );
}

function DockHint({ empty }: { empty: boolean }) {
  const hasModels = useApp((s) => allModels(s.providers).length > 0);
  const sendKey = useApp((s) => s.settings.send_key);
  const callable = useApp((s) => canCall(s) && (allModels(s.providers).length > 1 || canDelegate(s)));
  if (!hasModels)
    return (
      <div className="dock-hint">
        Nenhum modelo disponível.{" "}
        <button type="button" onClick={() => openSettings("providers")}>
          Conectar um provedor
        </button>
      </div>
    );
  if (!empty) return <div className="dock-hint" />;
  const ctrl = sendKey === "ctrl-enter";
  return (
    <div className="dock-hint">
      <kbd>{ctrl ? kbd("Ctrl ↵") : "↵"}</kbd> envia · <kbd>{ctrl ? "↵" : "⇧ ↵"}</kbd> nova linha · <kbd>{kbd("Ctrl K")}</kbd> buscar
      {callable && (
        <>
          {" "}· <kbd>@</kbd> chama outro modelo, o Code ou um agente
        </>
      )}
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Boa noite" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

/** Empty-state line above the composer: the user's nickname, or what a temporary chat means. */
function Greeting() {
  const nickname = useApp((s) => s.settings.nickname.trim());
  const temp = useApp((s) => s.pendingTemporary);
  const code = useApp((s) => s.pendingKind === "code");
  const rt = useApp((s) => currentRuntime(s));
  if (code)
    return (
      <div className="greeting is-code">
        <b>Sessão de código</b>
        <span>
          {rt.family === "redir"
            ? `O ${rt.name} trabalha na pasta escolhida com o próprio harness; o CEU supervisiona o processo e registra cada ação.`
            : "O agente lê, edita e roda comandos na pasta escolhida, pedindo sua aprovação conforme o modo."}
        </span>
      </div>
    );
  if (temp)
    return (
      <div className="greeting is-temp">
        <b>Conversa temporária</b>
        <span>Não aparece no histórico e é apagada quando você sair dela.</span>
      </div>
    );
  if (!nickname) return null;
  return (
    <div className="greeting">
      <b>
        {greeting()}, {nickname}
      </b>
    </div>
  );
}

/** Until the suggestion model has read the history (or when there's no model yet). */
const HOME_SUGGESTIONS = [
  "Me ajude a organizar as prioridades da minha semana.",
  "Explique um conceito que eu deveria entender melhor, com exemplos.",
  "Revise um texto meu e sugira melhorias de clareza.",
];

/** Three starter cards under the empty composer, written from the user's history. */
function HomeSuggestions() {
  const items = useApp((s) => s.homeSuggestions);
  const typing = useComposer((s) => !!s.text.trim());
  useEffect(() => {
    loadHomeSuggestions();
  }, []);
  if (typing) return null;
  return (
    <div className="intro-sugs home-sugs">
      {(items.length ? items : HOME_SUGGESTIONS).map((s) => (
        <button
          key={s}
          type="button"
          className="intro-sug"
          onClick={() => {
            setText(s);
            focusComposer();
          }}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

export function Dock({ empty }: { empty: boolean }) {
  const text = useComposer((s) => s.text);
  const atts = useComposer((s) => s.atts);
  const generating = useApp((s) => s.generating.length > 0);
  const code = useApp((s) => isCodeSession(s));
  const agentic = useApp((s) => isAgentic(s));
  const agentName = useApp((s) => s.current?.conv.agent?.name || null);
  const parked = useApp((s) => !!s.approval?.request.approval_id && s.approval.messageId in (s.current?.msgs || {}));
  const pendingTemp = useApp((s) => s.pendingTemporary);
  const sendKey = useApp((s) => s.settings.send_key);
  const allProviders = useApp((s) => s.providers);
  const rt = useApp((s) => (isCodeSession(s) ? currentRuntime(s) : null));
  // an external harness only takes models it understands; with none, it runs its own default
  const providers = useMemo(() => (rt ? providersFor(rt, allProviders) : allProviders), [rt, allProviders]);
  const efforts = useApp((s) => s.efforts);
  const modelRef = useApp((s) => runtimeModel(s));
  const effort = useApp((s) => selectedEffort(runtimeModel(s), s));
  const pickerEfforts = useMemo(() => {
    if (rt?.family !== "redir") return efforts;
    const out = { ...efforts };
    for (const m of rt.models || []) {
      const levels = m.effortLevels || rt.efforts || [];
      if (levels.length) out[`${rt.id}::${m.id}`] = { levels, default: m.defaultEffort || levels[0] };
    }
    if (modelRef?.startsWith(`${rt.id}::`) && !out[modelRef] && rt.efforts?.length)
      out[modelRef] = { levels: rt.efforts, default: rt.efforts[0] };
    return out;
  }, [rt, efforts, modelRef]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const call = useComposer((s) => s.call);
  const callable = useApp((s) => canCall(s));
  const delegable = useApp((s) => canDelegate(s));
  const agents = useApp((s) => s.agents);
  const callName = useApp((s) => (call ? participantLabel(refOfCall(call), s) : null));
  const room = useApp((s) => !!s.current?.conv.room);
  const ready = canSend();
  const steering = generating && agentic && !!text.trim();
  void atts; // re-render on attachment status changes (canSend reads the store)

  // `@` before the caret opens the participant picker; picking one turns the token into a chip
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const mention = callable ? mentionAt(text, caret) : null;
  const query = mention ? mention.query : null;
  // Code targets are the recent project folders, fetched the first time the menu opens
  const [projects, setProjects] = useState<{ path: string; name: string }[] | null>(null);
  const askedProjects = useRef(false);
  useEffect(() => {
    if (query === null || askedProjects.current || !delegable) return;
    askedProjects.current = true;
    api
      .projects()
      .then((ps) => setProjects(ps.filter((p) => p.exists).map((p) => ({ path: p.project_path, name: p.name }))))
      .catch(() => {});
  }, [query, projects, delegable]);
  const mentionItems = useMemo<Target[]>(() => {
    if (query === null) return [];
    const models: Target[] = matchModels(allModels(allProviders), query, 6).map((m) => ({ kind: "model", key: m.ref, m }));
    return delegable ? [...models, ...matchSurfaces(query, projects || [], agents)] : models;
  }, [query, allProviders, delegable, projects, agents]);
  const menuOpen = !!mention && mention.start !== dismissed && mentionItems.length > 0;
  // highlighted row; back to the first whenever the query changes
  const [sel, setSel] = useState({ query: "", i: 0 });
  const active = sel.query === query ? Math.min(sel.i, Math.max(0, mentionItems.length - 1)) : 0;
  const setActive = (i: number) => setSel({ query: query ?? "", i });
  useEffect(() => {
    if (!call || callable) return;
    setCall(null); // left Chat (Code session, agent thread): calls don't apply there yet
  }, [call, callable]);

  const trackCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  const pickMention = async (t: Target) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    let after = text.slice(caret);
    if ((!before || /\s$/.test(before)) && after.startsWith(" ")) after = after.slice(1);
    const next = before + after;
    setText(next);
    setDismissed(null);
    let picked = callOf(t);
    if (!picked) {
      // "Code · escolher pasta…": the native folder picker
      try {
        const { path } = await api.pickProject();
        if (path) picked = { surface: "code", target: path };
      } catch (e: any) {
        toast(e.message);
      }
      if (picked) setProjects((ps) => [{ path: picked!.target, name: folderOf(picked!.target) }, ...(ps || []).filter((p) => p.path !== picked!.target)]);
    }
    if (picked) setCall(picked);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  };

  useLayoutEffect(() => {
    const ta = taRef.current!;
    composerInput.el = ta;
    // re-measure when the composer width changes (sidebar toggle, window resize)
    let w = 0;
    const ro = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - w) < 1) return;
      w = entry.contentRect.width;
      autosize(ta, innerHeight * 0.4);
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (taRef.current) autosize(taRef.current, innerHeight * 0.4);
  }, [text]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ctrlSend = sendKey === "ctrl-enter";
    if (menuOpen && !e.nativeEvent.isComposing) {
      const n = mentionItems.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((active + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionItems[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(mention!.start);
        return;
      }
    }
    if (e.key === "Backspace" && call && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      setCall(null);
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      const wantsSend = ctrlSend ? e.ctrlKey || e.metaKey : !e.shiftKey && !isMobile();
      if (wantsSend) {
        e.preventDefault();
        if (generating ? steering : canSend()) send();
      }
      return;
    }
    if (e.key === "Escape" && generating) {
      e.preventDefault();
      stop();
      return;
    }
    if (e.key === "ArrowUp" && !e.currentTarget.value && !useComposer.getState().atts.length) {
      e.preventDefault();
      editLast();
    }
  };

  const registerToggle = useCallback((fn: () => void) => {
    view.openModelPicker = fn;
  }, []);

  return (
    <div className="dock" id="dock">
      {empty && <Greeting />}
      {empty && code && <ProjectChip />}
      <form
        className={"composer" + (code ? " is-code" : "")}
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (steering) send();
          else if (generating) stop();
          else if (canSend()) send();
        }}
      >
        {menuOpen && <MentionMenu items={mentionItems} active={active} onPick={pickMention} onHover={setActive} />}
        <Attachments />
        {call && callable && <CallChip call={call} />}
        <textarea
          ref={taRef}
          id="input"
          rows={1}
          placeholder={
            agentic && generating
              ? "Mande uma correção ao agente…"
              : parked
                ? "Responda à aprovação acima, ou escreva para seguir sem ela"
                : agentName
                  ? `Fale com ${agentName}`
                  : code
                    ? "Descreva uma tarefa ou faça uma pergunta"
                    : call && call.surface !== "chat"
                      ? `O que ${callName} deve fazer? (vazio: o que a conversa pede)`
                      : callName
                        ? `Mensagem para ${callName}, ou envie vazio para passar a vez`
                        : room
                          ? "Escreva para a Room: os participantes respondem na sequência"
                          : empty && pendingTemp
                        ? "Mensagem temporária"
                        : "Mensagem"
          }
          aria-label="Mensagem"
          aria-expanded={menuOpen}
          aria-autocomplete="list"
          spellCheck
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            trackCaret(e.currentTarget);
          }}
          onSelect={(e) => trackCaret(e.currentTarget)}
          onBlur={() => setDismissed(mention ? mention.start : null)}
          onFocus={() => setDismissed(null)}
          onKeyDown={onKey}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files || []);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
        />
        <div className="composer-bar">
          <button type="button" className="icon-btn" data-tip="Anexar arquivos" aria-label="Anexar arquivos" onClick={() => fileRef.current?.click()}>
            <Icon name="attach" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
          {code && <ModeButton />}
          <div className="grow" />
          <ModelPicker
            providers={providers}
            efforts={pickerEfforts}
            modelRef={modelRef}
            effort={effort}
            onChange={(patch) => {
              if (patch.model !== undefined) setModel(patch.model);
              if (patch.effort !== undefined) setEffort(patch.effort);
            }}
            onManage={rt?.family === "redir" ? undefined : () => openSettings("providers")}
            registerToggle={registerToggle}
            emptyLabel={rt?.family === "redir" ? `Padrão do ${rt.name}` : undefined}
            manualModelPrefix={rt?.family === "redir" ? `${rt.id}::` : undefined}
            autoEfforts={rt?.family === "redir" ? rt.efforts : undefined}
          />
          {steering && (
            <button type="button" className="send-btn is-stop" aria-label="Interromper" data-tip="Interromper" data-kbd="Esc" onClick={() => stop()}>
              <Icon name="stop" />
            </button>
          )}
          <button
            type="submit"
            className={cx("send-btn", generating && !steering && "is-stop")}
            aria-label={steering ? "Enviar ao agente" : generating ? "Interromper" : "Enviar"}
            data-tip={steering ? "Enviar ao agente sem interromper" : generating ? "Interromper" : "Enviar"}
            data-kbd={generating && !steering ? "Esc" : undefined}
            disabled={generating ? false : !ready}
          >
            <Icon name={generating && !steering ? "stop" : "arrow-up"} />
          </button>
        </div>
      </form>
      {empty && !code && !pendingTemp && <HomeSuggestions />}
      <DockHint empty={empty} />
    </div>
  );
}
