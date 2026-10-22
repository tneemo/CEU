import { getLocale, tr, useLanguage } from "../lib/i18n";
// Message thread (port of the rendering half of web/js/thread.js).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiUrl, type Attachment, type CallSpec, type Message } from "../api";
import { Ic, Icon, iconHtml } from "../lib/icons";
import { renderMarkdown } from "../lib/markdown";
import { autosize, copyText, cx, download, extOf, formatSize, openExternal, reducedMotion, relTime } from "../lib/util";
import { branchFrom, canSpeak, editSubmit, openConversation, planExecMode, rate, regenerate, runPlan, speak, startEdit, switchBranch, view } from "../state/actions";
import { activePath, allModels, currentRuntime, prettyModel, providersFor, setS, siblings, useApp, type Current } from "../state/store";
import { openMenu, toast } from "../state/ui";
import { AgentIntro } from "./Agent";
import { ActivityGroup, ApprovalCard, ChangesCard, codeSegments, modeInfo, SteerNote } from "./Code";
import { refOfCall } from "../lib/mention";
import { ModelGlyph, Name } from "./Participant";
import { RoomIntro } from "./Room";

// ------------------------------------------------------------------ small pieces

function attPath(a: Attachment, convId: string) {
  if (a.source === "workspace") return `/api/conversations/${convId}/workspace/${a.id.split("/").map(encodeURIComponent).join("/")}`;
  return `/api/attachments/${a.id}`;
}

function Attachments({ atts, convId }: { atts: Attachment[]; convId: string }) {
  useLanguage();
  return (
    <div className="msg-atts">
      {atts.map((a) => {
        const path = attPath(a, convId);
        if (a.mime?.startsWith("image/"))
          return (
            <a
              key={a.id}
              className="att-img"
              href={apiUrl(path)}
              title={a.name}
              onClick={(e) => {
                e.preventDefault();
                openExternal(new URL(apiUrl(path), location.href).href);
              }}
            >
              <img src={apiUrl(path)} alt={a.name} loading="lazy" />
            </a>
          );
        return (
          <a
            key={a.id}
            className="att-file"
            href={apiUrl(path)}
            title={a.name}
            onClick={(e) => {
              e.preventDefault();
              download(path, a.name).catch((err) => toast(err.message));
            }}
          >
            <span className="fi">{extOf(a.name).slice(0, 4)}</span>
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span className="n">{a.name}</span>
              <span className="s">{formatSize(a.size || 0)}</span>
            </span>
            <Ic name="download" className="dl" />
          </a>
        );
      })}
    </div>
  );
}

function IconBtn({ name, tip, onClick, disabled, on }: { name: string; tip: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; on?: boolean }) {
  useLanguage();
  return (
    <button type="button" className={cx("icon-btn", on && "is-on")} aria-label={tip} aria-pressed={on} data-tip={tip} onClick={onClick} disabled={disabled}>
      <Icon name={name} />
    </button>
  );
}

function CopyBtn({ text }: { text: string }) {
  useLanguage();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!ok) return;
    const t = setTimeout(() => setOk(false), 1400);
    return () => clearTimeout(t);
  }, [ok]);
  return (
    <button
      type="button"
      className={cx("icon-btn", ok && "is-on")}
      aria-label={tr("Copiar")}
      data-tip={tr("Copiar")}
      onClick={async () => {
        if (await copyText(text)) setOk(true);
      }}
    >
      <Icon name={ok ? "check" : "copy"} />
    </button>
  );
}

function BranchNav({ cur, m }: { cur: Current; m: Message }) {
  useLanguage();
  const sibs = siblings(cur, m);
  if (sibs.length < 2) return <span />;
  const i = sibs.findIndex((x) => x.id === m.id);
  return (
    <span className="branch">
      <IconBtn name="chevron-left" tip={tr("Versão anterior")} disabled={i <= 0} onClick={() => switchBranch(sibs[i - 1])} />
      <span>
        {i + 1} / {sibs.length}
      </span>
      <IconBtn name="chevron-right" tip={tr("Próxima versão")} disabled={i >= sibs.length - 1} onClick={() => switchBranch(sibs[i + 1])} />
    </span>
  );
}

export function Cube() {
  useLanguage();
  return (
    <span className="cube-wrap">
      <span className="cube">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

const Markdown = memo(function Markdown({ src, streaming, className = "md" }: { src: string; streaming?: boolean; className?: string }) {
  const language = useLanguage();
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- The code-copy control is translated inside rendered Markdown.
  const html = useMemo(() => renderMarkdown(src), [src, language]);
  return <div className={cx(className, streaming && "is-streaming")} dangerouslySetInnerHTML={{ __html: html }} />;
});

// ------------------------------------------------------------------ user message

function EditBox({ m }: { m: Message }) {
  useLanguage();
  const ref = useRef<HTMLTextAreaElement>(null);
  const sendKey = useApp((s) => s.settings.send_key);
  useEffect(() => {
    const ta = ref.current!;
    autosize(ta, innerHeight * 0.5);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  const cancel = () => {
    view.scrollIntent = "keep";
    setS({ editingId: null });
  };
  const submit = () => {
    const v = ref.current!.value;
    if (!v.trim() && !m.attachments?.length) return;
    if (v === m.content) return cancel();
    editSubmit(m, v);
  };
  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        rows={1}
        aria-label={tr("Editar mensagem")}
        defaultValue={m.content}
        onInput={(e) => autosize(e.currentTarget, innerHeight * 0.5)}
        onKeyDown={(e) => {
          const ctrlSend = sendKey === "ctrl-enter";
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing && (ctrlSend ? e.ctrlKey || e.metaKey : !e.shiftKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="row">
        <button type="button" className="btn ghost" onClick={cancel}>
          {tr("Cancelar")}</button>
        <button type="button" className="btn primary" onClick={submit}>
          {tr("Enviar")}</button>
      </div>
    </div>
  );
}

function Bubble({ text }: { text: string }) {
  useLanguage();
  const ref = useRef<HTMLDivElement>(null);
  const [clampable, setClampable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!expanded) setClampable(el.scrollHeight > 17 * parseFloat(getComputedStyle(el).fontSize) * 1.6);
  }, [text, expanded]);
  return (
    <>
      <div ref={ref} className={cx("bubble", clampable && !expanded && "is-clamped")}>
        {text}
      </div>
      {clampable && (
        <button type="button" className="expand-btn" onClick={() => setExpanded((x) => !x)}>
          {expanded ? tr("Mostrar menos") : tr("Mostrar mais")}
        </button>
      )}
    </>
  );
}

const delegated = (call: CallSpec | null | undefined) => !!call && call.surface !== "chat";

/** Who a user message was for: a model (`@modelo`) or a surface the work was delegated to. */
function CallLabel({ call }: { call: CallSpec }) {
  useLanguage();
  const ref = refOfCall(call);
  return (
    <div className="msg-call">
      <span>{delegated(call) ? tr("delegado a") : tr("para")}</span>
      <ModelGlyph model={ref} />
      <b>
        <Name model={ref} />
      </b>
    </div>
  );
}

/** Opens the Code session / agent task a delegated reply ran in, at the reply. */
function OpenTarget({ call, label }: { call: CallSpec; label: string }) {
  useLanguage();
  if (call.surface === "chat" || !call.conversation_id) return null;
  const { conversation_id, message_id } = call;
  return (
    <button type="button" className="delegate-link" onClick={() => openConversation(conversation_id, { messageId: message_id || null })}>
      {label}
      <Icon name="chevron-right" />
    </button>
  );
}

/** Who is speaking, once a conversation has more than one participant. A delegated reply is its
 * surface (with the model that did the work); a Room's turn says where it is in the sequence. */
function Speaker({ m }: { m: Message }) {
  useLanguage();
  const call = m.call;
  const ref = delegated(call) ? refOfCall(call) : m.model;
  const turn = call?.surface === "chat" ? call.room : null;
  return (
    <div className={cx("speaker", call && "is-invited", delegated(call) && "is-delegated")}>
      <ModelGlyph model={ref} />
      <span>
        <Name model={ref} />
      </span>
      {delegated(call) && m.model && (
        <span className="via">
          · <Name model={m.model} />
        </span>
      )}
      {turn && <span className="via">· {turn.finale ? tr("encerramento") : turn.rounds > 1 ? tr("rodada {0}", turn.round) : `${turn.turn}/${turn.of}`}</span>}
      {delegated(call) && m.status !== "streaming" && <OpenTarget call={call!} label={call!.surface === "code" ? tr("Abrir sessão") : tr("Abrir tarefa")} />}
    </div>
  );
}

/** A delegated reply while the work runs elsewhere: where, a way to follow it, and its approval cards. */
function DelegateCard({ m }: { m: Message }) {
  useLanguage();
  const pending = useApp((s) => (s.approval?.messageId === m.id ? s.approval.request : null));
  const call = m.call!;
  return (
    <div className="delegate-card">
      <div className="dc-line">
        {pending ? <span className="pulse" aria-hidden="true" /> : <Cube />}
        <span className="label">{pending ? tr("Aguardando sua aprovação") : call.surface === "code" ? tr("Trabalhando na sessão de Code") : tr("O agente está trabalhando na tarefa")}</span>
        <OpenTarget call={call} label={tr("Acompanhar")} />
      </div>
      {pending && <ApprovalCard req={pending} />}
    </div>
  );
}

function UserMsg({ cur, m, last }: { cur: Current; m: Message; last: boolean }) {
  useLanguage();
  const editing = useApp((s) => s.editingId === m.id);
  return (
    <div className={cx("msg user", last && "is-last")} data-id={m.id}>
      {m.call && <CallLabel call={m.call} />}
      {!!m.attachments?.length && <Attachments atts={m.attachments} convId={cur.conv.id} />}
      {editing ? (
        <EditBox m={m} />
      ) : (
        <>
          {m.content && <Bubble text={m.content} />}
          <div className="actions">
            <span className="when" title={new Date(m.created_at * 1000).toLocaleString(getLocale())}>
              {relTime(m.created_at)}
            </span>
            <BranchNav cur={cur} m={m} />
            <IconBtn name="edit" tip={tr("Editar")} onClick={() => startEdit(m)} />
            <CopyBtn text={m.content} />
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ tool call / result

function ToolMsg({ cur, m, last }: { cur: Current; m: Message; last: boolean }) {
  useLanguage();
  const isResult = m.role === "tool_result";
  const hasError = isResult && /ERRO:/.test(m.notice || "");
  return (
    <div className={cx("msg tool", last && "is-last")} data-id={m.id}>
      {m.content?.trim() && <Markdown src={m.content} />}
      <div className={cx("tool-card", isResult && "is-result", hasError && "is-error")}>
        <Ic name={hasError ? "alert" : isResult ? "check" : "cube"} />
        <pre className="body">{m.notice || (isResult ? tr("(sem saída)") : tr("Executando ferramenta…"))}</pre>
      </div>
      {isResult && !!m.attachments?.length && <Attachments atts={m.attachments} convId={cur.conv.id} />}
    </div>
  );
}

// ------------------------------------------------------------------ assistant message

function lastLine(text: string) {
  const t = text.trim().split("\n").filter((l) => l.trim()).pop() || "";
  return t.replace(/[*_#`>]/g, "").slice(-120);
}

function secs(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`;
}

function Reasoning({ m, live }: { m: Message; live: boolean }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <div className={cx("reasoning", open && "is-open")}>
      <button type="button" className="reasoning-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {live ? (
          <>
            <Cube />
            <span className="label">{tr("Pensando")}</span>
            <span className="live">{lastLine(m.reasoning)}</span>
          </>
        ) : (
          <>
            <Ic name="chevron-right" className="chev" />
            <span>{m.reasoning_ms ? tr("Pensou por {0}", secs(m.reasoning_ms)) : tr("Raciocínio")}</span>
          </>
        )}
      </button>
      {open && <Markdown src={m.reasoning} className="reasoning-body md" />}
    </div>
  );
}

function ModelMeta({ m }: { m: Message }) {
  useLanguage();
  const allProviders = useApp((s) => s.providers);
  // a code session under an external harness: only its models apply, and "no model" is its own default
  const rt = useApp((s) => (s.current?.conv.kind === "code" ? currentRuntime(s) : null));
  const providers = useMemo(() => (rt ? providersFor(rt, allProviders) : allProviders), [rt, allProviders]);
  const used = m.model_run?.actual_model;
  const requested = m.model_run?.requested_model;
  return (
    <button
      type="button"
      data-tip={used ? tr("Modelo usado: {0}{1}", used, requested && requested !== used ? tr(" · solicitado: {0}", requested) : "") : tr("Regenerar com outro modelo")}
      style={{ color: "inherit" }}
      onClick={(e) => {
        openMenu({
          anchor: e.currentTarget,
          placement: "top-start",
          items: [
            { header: tr("Regenerar com") },
            ...(rt?.family === "redir" ? [{ label: "Auto", sub: tr("Padrão do {0}", rt.name), checked: !m.model, onSelect: () => regenerate(m, null) }] : []),
            ...allModels(providers).map((x) => ({
              label: x.name,
              sub: x.provider.name,
              checked: x.ref === m.model,
              onSelect: () => regenerate(m, x.ref),
            })),
          ],
        });
      }}
    >
      {used || (!m.model && rt?.model_kinds ? `Auto · ${rt.name}` : prettyModel(m.model, providers))}
    </button>
  );
}

function AssistantMsg({ cur, m, last, multi }: { cur: Current; m: Message; last: boolean; multi?: boolean }) {
  useLanguage();
  const streaming = m.status === "streaming";
  const speaking = useApp((s) => s.speakingId === m.id);
  const allProviders = useApp((s) => s.providers);
  const rt = cur.conv.kind === "code" ? currentRuntime() : null;
  const modelProviders = rt ? providersFor(rt, allProviders) : allProviders;
  const thinkingNow = streaming && !!m.reasoning && !m.content;
  const showPending = streaming && !m.content && !m.reasoning;
  // content that arrives after the placeholder fades in; content present at mount doesn't
  const startedEmpty = useRef(!m.content);
  const u = m.usage;
  const stats: string[] = [];
  if (u?.output) stats.push(`${u.output.toLocaleString(getLocale())} tokens`);
  if (u?.tps) stats.push(`${u.tps.toLocaleString(getLocale())} tok/s`);
  if (u?.ttft_ms) stats.push(tr("{0}s até o 1º token", (u.ttft_ms / 1000).toFixed(1)));

  return (
    <div className={cx("msg assistant", last && "is-last", startedEmpty.current && streaming && m.content && "is-entering")} data-id={m.id}>
      {multi && <Speaker m={m} />}
      {m.reasoning && <Reasoning m={m} live={thinkingNow} />}
      {showPending && delegated(m.call) ? (
        <DelegateCard m={m} />
      ) : (
        showPending && (
          <div className="pending">
            <Cube />
            <span className="label">{tr("Gerando")}</span>
          </div>
        )
      )}
      {(m.content || !streaming) && <Markdown src={m.content} streaming={streaming} />}
      {!streaming && (
        <>
          <div>
            {m.notice && <div className="notice">{m.notice}</div>}
            {m.status === "error" && (
              <div className="error-card">
                <Ic name="alert" />
                <div className="body">
                  {m.error || tr("Algo deu errado.")}
                  <br />
                  <button type="button" className="btn" onClick={() => regenerate(m)}>
                    <Ic name="retry" />
                    {tr("Tentar novamente")}</button>
                </div>
              </div>
            )}
          </div>
          <div className="actions">
            {m.content && <CopyBtn text={m.content} />}
            {m.content && canSpeak() && <IconBtn name="speaker" tip={speaking ? tr("Parar leitura") : tr("Ler em voz alta")} on={speaking} onClick={() => speak(m)} />}
            {m.status === "complete" && (
              <>
                <IconBtn name="thumb-up" tip={tr("Boa resposta")} on={m.feedback === 1} onClick={() => rate(m, 1)} />
                <IconBtn name="thumb-down" tip={tr("Resposta ruim")} on={m.feedback === -1} onClick={() => rate(m, -1)} />
              </>
            )}
            <IconBtn name="retry" tip={tr("Regenerar")} onClick={() => regenerate(m)} />
            <IconBtn
              name="more"
              tip={tr("Mais ações")}
              onClick={(e) =>
                openMenu({
                  anchor: e.currentTarget,
                  placement: "top-start",
                  items: [
                    { label: tr("Ramificar em nova conversa"), icon: "branch", onSelect: () => branchFrom(m) },
                    { label: tr("Copiar como Markdown"), icon: "copy", disabled: !m.content, onSelect: () => copyText(m.content).then(() => toast(tr("Resposta copiada"))) },
                    // delegated work is asked again of the same surface, not of another model
                    ...(delegated(m.call)
                      ? []
                      : [
                          "sep" as const,
                          { header: tr("Regenerar com") },
                          ...(rt?.family === "redir" ? [{ label: "Auto", sub: tr("Padrão do {0}", rt.name), checked: !m.model, onSelect: () => regenerate(m, null) }] : []),
                          ...allModels(modelProviders).map((x) => ({ label: x.name, sub: x.provider.name, checked: x.ref === m.model, onSelect: () => regenerate(m, x.ref) })),
                        ]),
                  ],
                })
              }
            />
            <BranchNav cur={cur} m={m} />
            <span className="meta">
              <ModelMeta m={m} />
              {m.status === "stopped" && (
                <>
                  <span className="sep">·</span>{tr("Interrompido")}</>
              )}
              {stats.length > 0 && (
                <span className="stat">
                  <span className="sep">·</span>
                  {stats.join(" · ")}
                </span>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ thread

interface Turn {
  first: string;
  msgs: Message[];
}

/** `multi`: more than one model takes part in the conversation, so replies show who is speaking. */
function renderMsg(cur: Current, m: Message, last: boolean, multi = false) {
  if (m.role === "user") return <UserMsg key={m.id} cur={cur} m={m} last={last} />;
  // an agent turn parked on an approval: the activity line above carries the state
  if (m.role === "assistant" && m.status === "waiting" && !m.content) return null;
  if (m.role === "tool_call" || m.role === "tool_result") return <ToolMsg key={m.id} cur={cur} m={m} last={last} />;
  return <AssistantMsg key={m.id} cur={cur} m={m} last={last} multi={multi} />;
}

/** A code-session turn: prose between collapsible runs of tool calls, then the changes card. */
function CodeTurn({ cur, msgs, lastId }: { cur: Current; msgs: Message[]; lastId: string | undefined }) {
  useLanguage();
  const toolLive = useApp((s) => s.toolLive);
  const segs = useMemo(() => codeSegments(msgs, toolLive), [msgs, toolLive]);
  const tail = msgs[msgs.length - 1];
  // an agent's executor (server/coordination.py) runs read-only by role, not as a plan waiting to be carried out
  const planDone = cur.conv.permission_mode === "plan" && !cur.conv.origin?.role && tail?.id === lastId && tail.role === "assistant" && tail.status === "complete";
  return (
    <>
      {segs.map((sg) => {
        if (sg.kind === "msg") return renderMsg(cur, sg.m, sg.m.id === lastId);
        if (sg.kind === "prose")
          return (
            <div key={sg.m.id} className="msg tool-prose" data-id={sg.m.id}>
              <Markdown src={sg.m.content} />
            </div>
          );
        if (sg.kind === "activity") return <ActivityGroup key={sg.key} items={sg.items} />;
        if (sg.kind === "steer") return <SteerNote key={sg.key} texts={sg.texts} />;
        if (sg.kind === "files") return <Attachments key={sg.key} atts={sg.m.attachments} convId={cur.conv.id} />;
        return <ChangesCard key={"ch" + sg.m.id} m={sg.m} edits={sg.edits} />;
      })}
      {planDone && (
        <div className="plan-actions">
          <button type="button" className="btn primary" onClick={() => runPlan()}>
            {tr("Executar o plano")}</button>
          <span>{tr("Muda para “")}{modeInfo(planExecMode()).label}{tr("” e pede a execução. Ou escreva ajustes ao plano.")}</span>
        </div>
      )}
    </>
  );
}

export function Thread() {
  useLanguage();
  const cur = useApp((s) => s.current);
  const openSeq = useApp((s) => s.openSeq);
  const threadRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const anchorRef = useRef<string | null>(null);
  const [toBottom, setToBottom] = useState(false);

  const path = useMemo(() => activePath(cur), [cur]);
  const turns = useMemo(() => {
    const out: Turn[] = [];
    for (const m of path) {
      if (m.role === "user" || !out.length) out.push({ first: m.id, msgs: [] });
      out[out.length - 1].msgs.push(m);
    }
    return out;
  }, [path]);
  const lastTurn = turns[turns.length - 1]?.first ?? null;
  const multi = useMemo(() => path.some((m) => !!m.call), [path]);

  // Decide the anchor during render (idempotent) so the min-height is in place before scrolling.
  const intent = view.scrollIntent;
  if (intent === "anchor") anchorRef.current = lastTurn;
  else if (intent === "bottom" || (intent && typeof intent === "object" && "highlight" in intent)) anchorRef.current = null;
  if (anchorRef.current !== lastTurn) anchorRef.current = null;

  const updateToBottom = () => {
    const t = threadRef.current;
    const last = innerRef.current?.lastElementChild?.lastElementChild;
    if (!t || !last || !t.clientHeight) return setToBottom(false);
    setToBottom(last.getBoundingClientRect().bottom - t.getBoundingClientRect().bottom > 40);
  };

  const railInView = () => {
    const rail = railRef.current;
    const t = threadRef.current;
    if (!rail || !t || !rail.childElementCount) return;
    const tr = t.getBoundingClientRect();
    // match by message id: tool calls are grouped in agent turns, so .msg and rail entries don't line up by index
    const byId = new Map<string, Element>();
    innerRef.current!.querySelectorAll(".msg[data-id]").forEach((el) => byId.set((el as HTMLElement).dataset.id!, el));
    Array.from(rail.children).forEach((b) => {
      const el = byId.get((b as HTMLElement).dataset.mid || "");
      const r = el?.getBoundingClientRect();
      b.classList.toggle("in-view", !!r && r.bottom > tr.top + 20 && r.top < tr.bottom - 20);
    });
  };

  // consume scroll intents after the DOM reflects the new state
  useLayoutEffect(() => {
    const t = threadRef.current;
    const intent = view.scrollIntent;
    view.scrollIntent = null;
    if (t && intent) {
      const smooth = !reducedMotion();
      if (intent === "bottom") t.scrollTop = t.scrollHeight;
      else if (intent === "anchor") {
        const turn = innerRef.current?.lastElementChild as HTMLElement | null;
        if (turn) t.scrollTo({ top: turn.offsetTop - 8, behavior: smooth ? "smooth" : "auto" });
      } else if (typeof intent === "object" && "reveal" in intent) {
        const el = t.querySelector(`.msg[data-id="${intent.reveal}"]`);
        if (el && el.getBoundingClientRect().top > t.getBoundingClientRect().bottom - 80) el.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
      } else if (typeof intent === "object" && "highlight" in intent) {
        const el = t.querySelector<HTMLElement>(`.msg[data-id="${intent.highlight}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.animate([{ background: "var(--accent-2)" }, { background: "transparent" }], { duration: 1600, easing: "ease-out" });
        } else t.scrollTop = t.scrollHeight;
      }
    }
    updateToBottom();
    railInView();
  });

  useEffect(() => {
    const t = threadRef.current!;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        updateToBottom();
        railInView();
      });
    };
    t.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      t.style.setProperty("--anchor-h", Math.max(0, t.clientHeight - 24) + "px");
      updateToBottom();
    });
    ro.observe(t);
    return () => {
      t.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  const scrollToEnd = () => {
    const t = threadRef.current!;
    const last = innerRef.current?.lastElementChild?.lastElementChild;
    if (!last) return;
    const below = last.getBoundingClientRect().bottom - t.getBoundingClientRect().bottom + 32;
    t.scrollBy({ top: Math.max(0, below), behavior: reducedMotion() ? "auto" : "smooth" });
  };

  // delegated clicks inside rendered markdown: copy buttons and external links
  const onInnerClick = async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>("[data-copy-code]");
    if (btn) {
      const code = btn.closest(".code-block")?.querySelector("pre code")?.textContent || "";
      if (await copyText(code)) {
        btn.innerHTML = iconHtml("check") + tr("<span>Copiado</span>");
        setTimeout(() => (btn.innerHTML = iconHtml("copy") + tr("<span>Copiar</span>")), 1500);
      }
      return;
    }
    const a = target.closest<HTMLAnchorElement>(".md a[href]");
    if (a && /^https?:/i.test(a.href)) {
      e.preventDefault();
      openExternal(a.href);
    }
  };

  const showRail = path.length >= 6;

  return (
    <>
      <div className="thread" id="thread" ref={threadRef} tabIndex={-1}>
        <div className="thread-inner is-entering" key={openSeq} ref={innerRef} onClick={onInnerClick}>
          {cur && cur.conv.kind === "agent" && !path.length && <AgentIntro />}
          {cur && cur.conv.room && !path.length && <RoomIntro />}
          {cur &&
            turns.map((turn) => (
              <div key={turn.first} className={cx("turn", turn.first === anchorRef.current && "is-anchor")} data-first={turn.first}>
                {cur.conv.kind && cur.conv.kind !== "chat" ? (
                  <CodeTurn cur={cur} msgs={turn.msgs} lastId={path[path.length - 1]?.id} />
                ) : (
                  turn.msgs.map((m) => renderMsg(cur, m, m === path[path.length - 1], multi))
                )}
              </div>
            ))}
        </div>
      </div>
      <nav className={cx("rail", showRail && "is-visible")} aria-label={tr("Mapa da conversa")} ref={railRef}>
        {showRail &&
          path.filter((m) => m.role !== "tool_call" && m.role !== "tool_result").map((m) => {
            const isUser = m.role === "user";
            const len = (m.content || "").length;
            const w = isUser ? 7 : Math.round(9 + Math.min(13, Math.log2(len / 80 + 1) * 3));
            const snippet = (m.content || "").replace(/\s+/g, " ").slice(0, 60) || (isUser ? tr("Mensagem") : tr("Resposta"));
            return (
              <button
                key={m.id}
                type="button"
                data-mid={m.id}
                className={isUser ? "u" : "a"}
                style={{ width: w }}
                data-tip={snippet}
                aria-label={snippet}
                onClick={() => {
                  const el = innerRef.current?.querySelector<HTMLElement>(`.msg[data-id="${m.id}"]`);
                  if (el) threadRef.current!.scrollTo({ top: el.offsetTop - 12, behavior: reducedMotion() ? "auto" : "smooth" });
                }}
              />
            );
          })}
      </nav>
      <button className={cx("to-bottom", toBottom && "is-visible")} aria-label={tr("Ir para o fim")} tabIndex={-1} onClick={scrollToEnd}>
        <Icon name="arrow-down" />
      </button>
    </>
  );
}
