import { tr, translateLabel, useLanguage } from "../lib/i18n";
// Code sessions: how the agent's work reads in the thread (see docs/referencias-code.md §4).
// Tool calls collapse into short summary lines between the model's prose; each line opens
// into one row per call (command + output, diff, search), and a pending call shows the
// approval card in place.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequest, Message, PermissionMode, RuntimeInfo, ToolCall, ToolResult } from "../api";
import { Ic, Icon } from "../lib/icons";
import { cx } from "../lib/util";
import { answerApproval, openConversation, undoTurn } from "../state/actions";
import { useApp, type ToolLive } from "../state/store";
import { confirmDialog } from "../state/ui";
import { Cube } from "./Thread";

// ------------------------------------------------------------------ permission modes

export const MODES = (): { id: PermissionMode; label: string; sub: string; icon: string }[] => ([
  { id: "manual", label: "Manual", sub: tr("Pergunta antes de editar e antes de rodar comandos"), icon: "user" },
  { id: "accept_edits", label: tr("Aceitar edições"), sub: tr("Edita direto; pergunta antes de rodar comandos"), icon: "edit" },
  { id: "plan", label: tr("Plano"), sub: tr("Só explora e propõe um plano, sem editar"), icon: "file" },
  { id: "auto", label: tr("Automático"), sub: tr("Edita e roda comandos sem perguntar"), icon: "gauge" },
]);

export const modeInfo = (m: PermissionMode | null | undefined) => MODES().find((x) => x.id === m) || MODES()[0];

/** Runtimes that cannot start a session yet say why (server/code_runtimes.py). */
export const RUNTIME_STATUS = (): Record<RuntimeInfo["status"], string> => ({
  ready: tr("Pronto"),
  unavailable: tr("Indisponível"),
  planned: tr("Driver não implementado"),
});

// ------------------------------------------------------------------ diff

export function DiffView({ diff, max = 400 }: { diff: string; max?: number }) {
  useLanguage();
  const rows = useMemo(() => {
    const out: { k: "add" | "del" | "ctx" | "hunk"; n: number | null; t: string }[] = [];
    let oldN = 0;
    let newN = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("---") || line.startsWith("+++")) continue;
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (h) {
        oldN = +h[1];
        newN = +h[2];
        if (out.length) out.push({ k: "hunk", n: null, t: "⋯" });
        continue;
      }
      if (line.startsWith("+")) out.push({ k: "add", n: newN++, t: line.slice(1) });
      else if (line.startsWith("-")) out.push({ k: "del", n: oldN++, t: line.slice(1) });
      else if (line.startsWith(" ")) {
        out.push({ k: "ctx", n: newN++, t: line.slice(1) });
        oldN++;
      }
    }
    return out;
  }, [diff]);
  if (!rows.length) return <div className="code-empty">{tr("Sem diferenças de conteúdo.")}</div>;
  const shown = rows.slice(0, max);
  return (
    <div className="diff" role="table" aria-label={tr("Diferenças")}>
      {shown.map((r, i) => (
        <div key={i} className={"diff-row " + r.k} role="row">
          <span className="ln">{r.n ?? ""}</span>
          <span className="sg">{r.k === "add" ? "+" : r.k === "del" ? "−" : ""}</span>
          <span className="tx">{r.t || " "}</span>
        </div>
      ))}
      {rows.length > shown.length && <div className="diff-row hunk">{tr("… mais ")}{rows.length - shown.length} {tr("linhas")}</div>}
    </div>
  );
}

function Stat({ added, removed }: { added?: number; removed?: number }) {
  useLanguage();
  return (
    <span className="stat-ar">
      <span className="a">+{added || 0}</span>
      <span className="r">−{removed || 0}</span>
    </span>
  );
}

// ------------------------------------------------------------------ one call

const base = (p?: string) => (p || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || p || "";

interface Item {
  call: ToolCall;
  result?: ToolResult;
  live?: ToolLive;
}

/** Agent threads use the code tools on a granted folder as host_*: same rendering. */
const toolName = (name: string) => name.replace(/^host_/, "");

// an agent's coordination tools (server/coordination.py)
const ROLE_VERB = (): Record<string, string> => ({ investigate: tr("investigação"), implement: tr("implementação"), review: tr("revisão") });
const KIND_WORD = (): Record<string, string> => ({
  problem: tr("problema"), hypothesis: tr("hipótese"), contradiction: tr("contradição"), question: tr("pergunta"), lead: tr("pista"), finding: tr("achado"),
});

function isEdit(name: string) {
  const n = toolName(name);
  return n === "edit_file" || n === "write_file";
}

const host = (url?: string) => {
  try {
    return new URL(url || "").hostname.replace(/^www\./, "");
  } catch {
    return url || "";
  }
};

function label(it: Item) {
  const { call, result } = it;
  const a = call.input || {};
  const meta = result?.meta || {};
  const name = toolName(call.name);
  if (!result) {
    // not done yet (running or waiting for approval): say what it will do
    const verb: Record<string, string> = {
      read_file: tr("Ler"), list_dir: tr("Listar"), glob: tr("Procurar"), grep: tr("Buscar"), edit_file: tr("Editar"), write_file: tr("Escrever"),
    };
    if (verb[name]) return <>{verb[name]} <code>{a.path || a.pattern || "."}</code></>;
    if (name === "web_search") return <>{tr("Pesquisar ")}<code>{a.query}</code></>;
    if (name === "fetch_url") return <>{tr("Abrir ")}<code>{host(a.url)}</code></>;
    if (name === "create_task") return <>{tr("Criar a tarefa ")}<b>{a.title}</b></>;
    if (name === "delegate") return <>{tr("Pedir ")}{ROLE_VERB()[a.role] || tr("trabalho")} {tr("a ")}<b>{a.executor}</b></>;
    if (name === "save_note") return <>{tr("Anotar ")}<span className="dim">“{(a.content || "").slice(0, 90)}”</span></>;
    if (name === "run_code") return <>{tr("Executar ")}{a.language === "bash" ? "Bash" : "Python"}</>;
  }
  switch (name) {
    case "web_search":
      return <>{tr("Pesquisou ")}<code>{a.query}</code>{meta.count != null && <span className="dim"> · {meta.count} {tr("resultado")}{meta.count === 1 ? "" : "s"}</span>}</>;
    case "fetch_url":
      return <>{tr("Leu ")}<code>{host(meta.url || a.url)}</code>{meta.title && <span className="dim"> · {meta.title}</span>}</>;
    case "run_code":
      return <>{tr("Executou ")}{a.language === "bash" ? "Bash" : "Python"}<span className="dim"> {tr("· no computador do agente")}</span></>;
    case "list_files":
      return <>{tr("Listou seus arquivos")}</>;
    case "save_note":
      return <>{tr("Anotou ")}<span className="dim">“{(a.content || "").slice(0, 90)}”</span></>;
    case "delete_note":
      return <>{tr("Apagou uma nota")}</>;
    case "create_task":
      return <>{tr("Criou a tarefa ")}<b>{a.title}</b></>;
    case "list_tasks":
      return <>{tr("Consultou as tarefas")}</>;
    case "update_task": {
      // declaring the task done may have run the final review (server/coordination.py settle)
      const review = meta.executor ? (
        <span className="dim">
          {" "}
          {tr("· revisão final por ")}{meta.executor}: {meta.verdict === "approved" ? tr("aprovou") : meta.verdict === "changes" ? tr("pediu mudanças") : tr("sem veredito")}
        </span>
      ) : null;
      if (a.state === "done" && result)
        return result.is_error ? <>{tr("Ainda não pôde concluir")}{review || <span className="dim"> · {(result.output || "").replace(/^Ainda não dá para concluir: /, "").slice(0, 90)}</span>}</> : <>{tr("Concluiu a tarefa")}{review}</>;
      return result?.is_error ? <>{tr("Tentou atualizar a tarefa")}<span className="dim"> · {(result.output || "").slice(0, 90)}</span></> : <>{tr("Atualizou a tarefa")}{a.state && <span className="dim"> · {a.state === "done" ? tr("concluir") : a.state === "blocked" ? tr("precisa de você") : tr("continuar")}</span>}</>;
    }
    case "raise_issue":
      return <>{tr("Registrou ")}{KIND_WORD()[a.kind] || tr("questão")}: <span className="dim">“{(a.title || "").slice(0, 90)}”</span></>;
    case "resolve_issue":
      return <>{a.status === "discarded" ? tr("Descartou") : tr("Resolveu")} {tr("uma questão")}<span className="dim"> · {(a.resolution || "").slice(0, 90)}</span></>;
    case "delegate": {
      const role = ROLE_VERB()[a.role] || tr("trabalho");
      const verdict = meta.verdict === "approved" ? tr(" · aprovou") : meta.verdict === "changes" ? tr(" · pediu mudanças") : "";
      const raised = (meta.issues || []).length;
      return (
        <>
          {role.charAt(0).toUpperCase() + role.slice(1)} {tr("por ")}<b>{meta.executor || a.executor}</b>
          <span className="dim">
            {verdict}
            {raised ? ` · ${raised} ${raised === 1 ? tr("questão") : tr("questões")}` : ""}
          </span>
        </>
      );
    }
  }
  switch (name) {
    case "read_file":
      return <>{tr("Leu ")}<code>{a.path}</code>{a.offset ? <span className="dim"> {tr("· a partir da linha ")}{a.offset}</span> : null}</>;
    case "list_dir":
      return <>{tr("Listou ")}<code>{a.path || "."}</code></>;
    case "glob":
      return <>{tr("Procurou ")}<code>{a.pattern}</code>{meta.count != null && <span className="dim"> · {meta.count} {tr("arquivo")}{meta.count === 1 ? "" : "s"}</span>}</>;
    case "grep":
      return <>{tr("Buscou ")}<code>{a.pattern}</code>{meta.count != null && <span className="dim"> · {meta.count} {tr("resultado")}{meta.count === 1 ? "" : "s"}</span>}</>;
    // an external harness (REDIR) reports the file, not the line counts
    case "edit_file":
      return <>{tr("Editou ")}<code>{meta.path || a.path}</code>{result && !result.is_error && meta.added != null && <Stat added={meta.added} removed={meta.removed} />}</>;
    case "write_file":
      return <>{meta.created === false ? tr("Reescreveu") : tr("Criou")} <code>{meta.path || a.path}</code>{result && !result.is_error && meta.added != null && <Stat added={meta.added} removed={meta.removed} />}</>;
    case "delete_file":
      return <>{tr("Apagou ")}<code>{meta.path || a.path}</code></>;
    case "run_command":
      return <>{a.description || <code>{a.command}</code>}</>;
    default:
      return <>{call.name}</>;
  }
}

function runningLabel(it: Item) {
  const a = it.call.input || {};
  switch (toolName(it.call.name)) {
    case "read_file": return tr("Lendo {0}", base(a.path));
    case "list_dir": return tr("Listando {0}", a.path || ".");
    case "glob": case "grep": return tr("Buscando {0}", a.pattern);
    case "edit_file": return tr("Editando {0}", base(a.path));
    case "write_file": return tr("Escrevendo {0}", base(a.path));
    case "run_command": return a.description || a.command;
    case "web_search": return tr("Pesquisando “{0}”", a.query);
    case "fetch_url": return tr("Lendo {0}", host(a.url));
    case "run_code": return tr("Executando código");
    case "save_note": return tr("Anotando");
    case "create_task": return tr("Criando a tarefa “{0}”", a.title);
    case "delegate": return tr("{0} trabalhando ({1})", a.executor, ROLE_VERB()[a.role] || tr("trabalho"));
    case "update_task": return a.state === "done" ? tr("Conferindo antes de concluir") : tr("Atualizando a tarefa");
    default: return it.call.name;
  }
}

const ICONS: Record<string, string> = {
  read_file: "file", list_dir: "archive", glob: "search", grep: "search",
  edit_file: "edit", write_file: "edit", delete_file: "trash", run_command: "tools",
  web_search: "search", fetch_url: "external", run_code: "cube", list_files: "archive",
  save_note: "memory", delete_note: "memory", create_task: "new", list_tasks: "filter",
  delegate: "user", raise_issue: "alert", resolve_issue: "check", update_task: "retry",
};

function OutputBox({ text, follow }: { text: string; follow: boolean }) {
  useLanguage();
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, follow]);
  return <pre ref={ref} className="out-box">{text || " "}</pre>;
}

function ItemBody({ it }: { it: Item }) {
  useLanguage();
  const { call, result, live } = it;
  const meta = result?.meta || {};
  if (meta.denied)
    return <div className="denied">{tr("Você negou esta ação")}{meta.reason ? `: “${meta.reason}”` : "."}</div>;
  if (call.name === "run_code") {
    const out = result ? result.output : live?.output || "";
    return (
      <div className="cmd">
        <pre className="out-box code-in">{call.input.code}</pre>
        {out && <OutputBox text={out} follow={!result} />}
      </div>
    );
  }
  if (toolName(call.name) === "run_command") {
    const running = !result && !!live?.running;
    const out = result ? meta.output ?? result.output : live?.output || "";
    return (
      <div className="cmd">
        <div className="cmd-line"><span className="ps">$</span>{call.input.command}</div>
        {(out || running) && <OutputBox text={out} follow={running} />}
        {result && (meta.exit_code || meta.timed_out || meta.cancelled) ? (
          <div className="cmd-exit">
            {meta.timed_out ? tr("Interrompido pelo tempo limite") : meta.cancelled ? tr("Interrompido") : tr("Código de saída {0}", meta.exit_code)}
            {meta.ms != null && ` · ${(meta.ms / 1000).toFixed(1)}s`}
          </div>
        ) : null}
      </div>
    );
  }
  if (call.name === "delegate" || (call.name === "update_task" && meta.conversation_id)) {
    const out = result ? result.output : live?.output || "";
    const session = meta.conversation_id;
    return (
      <div className="cmd">
        {call.name === "delegate" && <div className="cmd-line">{call.input.request}</div>}
        {out && <OutputBox text={out} follow={!result} />}
        {session && (
          <button type="button" className="btn ghost delegate-open" onClick={() => openConversation(session, { messageId: meta.message_id || null })}>
            <Ic name="external" />
            {tr("Abrir a sessão do executor")}</button>
        )}
      </div>
    );
  }
  if (isEdit(call.name) && meta.diff != null && !result?.is_error)
    return (
      <div className="edit-body">
        <div className="path-h">{meta.path}</div>
        <DiffView diff={meta.diff} />
      </div>
    );
  if (!result) return null;
  return <OutputBox text={result.output} follow={false} />;
}

function ItemRow({ it, pending }: { it: Item; pending: ApprovalRequest | null }) {
  useLanguage();
  const running = !it.result && !!it.live?.running && !pending;
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? (running && toolName(it.call.name) === "run_command");
  const failed = it.result?.is_error && !it.result.meta?.denied && !it.result.meta?.cancelled;
  const denied = !!it.result?.meta?.denied;
  return (
    <div className={cx("act-item", isOpen && "is-open", failed && "is-error", denied && "is-denied", running && "is-running")}>
      <button type="button" className="act-row" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        {running ? <Cube /> : <Ic name={failed ? "alert" : denied ? "close" : ICONS[toolName(it.call.name)] || "cube"} className="k" />}
        <span className="lbl">{label(it)}</span>
        {failed && <span className="tag err">{tr("erro")}</span>}
        {denied && <span className="tag">{tr("negado")}</span>}
        <Ic name="chevron-right" className="chev" />
      </button>
      {pending && pending.call_id === it.call.id ? <ApprovalCard req={pending} /> : isOpen && <div className="act-body"><ItemBody it={it} /></div>}
    </div>
  );
}

// ------------------------------------------------------------------ group of consecutive calls

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many.replace("#", String(n));
}

function summary(items: Item[]) {
  const parts: string[] = [];
  const named = (...names: string[]) => items.filter((i) => names.includes(toolName(i.call.name)) && !i.result?.meta?.denied);
  const reads = named("read_file");
  const searches = named("grep", "glob", "list_dir", "list_files");
  const edits = items.filter((i) => isEdit(i.call.name) && i.result && !i.result.is_error);
  const cmds = items.filter((i) => toolName(i.call.name) === "run_command" && i.result && !i.result.meta?.denied);
  const web = named("web_search");
  const pages = named("fetch_url");
  const code = named("run_code");
  const notes = named("save_note", "delete_note");
  const tasks = named("create_task");
  const delegated = named("delegate");
  const issues = named("raise_issue");
  const closed = named("resolve_issue");
  const finished = items.find((i) => toolName(i.call.name) === "update_task" && i.call.input.state === "done" && i.result && !i.result.is_error);
  if (web.length) parts.push(plural(web.length, tr("pesquisou na web"), tr("fez # pesquisas na web")));
  if (pages.length) parts.push(pages.length === 1 ? tr("leu {0}", host(pages[0].call.input.url)) : tr("leu {0} páginas", pages.length));
  if (code.length) parts.push(plural(code.length, tr("executou código"), tr("executou código # vezes")));
  if (notes.length) parts.push(plural(notes.length, tr("atualizou 1 nota"), tr("atualizou # notas")));
  if (tasks.length) parts.push(plural(tasks.length, tr("criou 1 tarefa"), tr("criou # tarefas")));
  if (delegated.length) parts.push(delegated.length === 1 ? tr("pediu {0} a {1}", ROLE_VERB()[delegated[0].call.input.role] || tr("trabalho"), delegated[0].call.input.executor) : tr("fez {0} pedidos a executores", delegated.length));
  if (issues.length) parts.push(plural(issues.length, tr("registrou 1 questão"), tr("registrou # questões")));
  if (closed.length) parts.push(plural(closed.length, tr("fechou 1 questão"), tr("fechou # questões")));
  if (finished) parts.push(finished.result!.meta.executor ? tr("concluiu após revisão de {0}", finished.result!.meta.executor) : tr("concluiu a tarefa"));
  if (reads.length) parts.push(reads.length === 1 ? tr("Leu {0}", base(reads[0].call.input.path)) : tr("Leu {0} arquivos", reads.length));
  if (searches.length) parts.push(plural(searches.length, tr("fez 1 busca"), tr("fez # buscas")));
  if (edits.length) {
    const files = new Set(edits.map((e) => e.result!.meta.path));
    const created = edits.every((e) => e.result!.meta.created);
    const verb = created ? tr("criou") : tr("editou");
    parts.push(files.size === 1 ? `${verb} ${base([...files][0])}` : tr("{0} {1} arquivos", verb, files.size));
  }
  if (cmds.length) parts.push(plural(cmds.length, tr("executou 1 comando"), tr("executou # comandos")));
  const asked = items.filter((i) => i.result?.meta?.denied).length;
  if (!parts.length && asked) parts.push(plural(asked, tr("pediu 1 ação"), tr("pediu # ações")));
  const text = parts.join(", ") || tr("Usou ferramentas");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ActivityGroup({ items }: { items: Item[] }) {
  useLanguage();
  const pending = useApp((s) => s.approval?.request || null);
  const hasPending = !!pending && items.some((i) => i.call.id === pending.call_id);
  const active = items.find((i) => !i.result && (i.live?.running || i.call.id === pending?.call_id));
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? (hasPending || !!active);
  const added = items.reduce((n, i) => n + (isEdit(i.call.name) && !i.result?.is_error ? i.result?.meta.added || 0 : 0), 0);
  const removed = items.reduce((n, i) => n + (isEdit(i.call.name) && !i.result?.is_error ? i.result?.meta.removed || 0 : 0), 0);
  const errors = items.filter((i) => i.result?.is_error && !i.result.meta?.denied && !i.result.meta?.cancelled).length;
  const denied = items.filter((i) => i.result?.meta?.denied).length;
  const waiting = items.some((i) => !i.result && !i.live) && !active;
  return (
    <div className={cx("activity", isOpen && "is-open", (active || waiting) && "is-live")}>
      <button type="button" className="act-sum" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        {hasPending ? (
          <>
            <span className="pulse" aria-hidden="true" />
            <span className="lbl">{tr("Aguardando sua aprovação")}</span>
          </>
        ) : active || waiting ? (
          <>
            <Cube />
            <span className="lbl">{active ? runningLabel(active) : tr("Preparando")}</span>
          </>
        ) : (
          <>
            <span className="lbl">{summary(items)}</span>
            {(added > 0 || removed > 0) && <Stat added={added} removed={removed} />}
            {errors > 0 && <span className="tag err">{plural(errors, tr("1 erro"), tr("# erros"))}</span>}
            {denied > 0 && <span className="tag">{plural(denied, tr("1 negada"), tr("# negadas"))}</span>}
          </>
        )}
        <Ic name="chevron-right" className="chev" />
      </button>
      {isOpen && (
        <div className="act-list">
          {items.map((it) => (
            <ItemRow key={it.call.id} it={it} pending={hasPending ? pending : null} />
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ approval

export function ApprovalCard({ req }: { req: ApprovalRequest }) {
  useLanguage();
  const [denying, setDenying] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const edit = req.kind === "edit";
  const nativeGit = req.kind === "git_write" || req.kind === "github_publish";
  // agent rules are per action class ("web", "host_command"…), not per command prefix
  const agentReq = !!req.action;
  // an external harness says what "always" means there (or null: it has no such option)
  const canAlways = req.always_label !== undefined ? !!req.always_label : agentReq || edit || !!req.rule.pattern;
  const alwaysLabel = req.always_label !== undefined ? (
    req.always_label ? translateLabel(req.always_label) : null
  ) : agentReq ? (
    <>{tr("Sempre permitir: ")}{translateLabel(req.action_label || "")}</>
  ) : req.kind === "git_write" ? (
    tr("Sempre permitir alterações Git locais neste projeto")
  ) : req.kind === "github_publish" ? (
    tr("Sempre permitir publicações no GitHub neste projeto")
  ) : edit ? (
    tr("Sempre permitir edições neste projeto")
  ) : canAlways ? (
    <>{tr("Sempre permitir ")}<code>{req.rule.pattern}</code> {tr("neste projeto")}</>
  ) : null;

  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);
  // Shortcuts arm only after the card has been on screen for a moment: a double press (or
  // key repeat) meant for the previous card must never approve one nobody has read yet.
  const armedAt = useRef(0);
  useEffect(() => {
    armedAt.current = performance.now() + 450;
  }, [req.call_id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || performance.now() < armedAt.current) return;
      const ae = document.activeElement as HTMLElement | null;
      const typing = /INPUT|TEXTAREA/.test(ae?.tagName || "") && ae?.id !== "input";
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const composerHasText = ae?.id === "input" && !!(ae as HTMLTextAreaElement).value;
      if (composerHasText) return;
      if (e.key === "1") answerApproval("allow");
      else if (e.key === "2" && canAlways) answerApproval("always");
      else if (e.key === "3") setDenying(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [canAlways]);

  const deny = () => answerApproval("deny", reasonRef.current?.value || "");
  return (
    <div className="approval" ref={cardRef} role="group" aria-label={tr("Aprovação pendente")}>
      <div className="ap-q">
        {req.kind === "agent" || req.kind === "unknown" ? (
          <>{translateLabel(req.summary || req.name)}</>
        ) : nativeGit ? (
          <>{translateLabel(req.summary || req.name)}</>
        ) : edit ? (
          <>
            <span>{req.name === "write_file" && !req.preview?.removed ? tr("Criar") : tr("Editar")}</span>
            <code>{req.preview?.path || req.input.path}</code>
            {req.preview?.diff != null && <Stat added={req.preview.added} removed={req.preview.removed} />}
          </>
        ) : (
          <>{req.input.description || tr("Rodar este comando?")}</>
        )}
      </div>
      {req.kind === "agent" ? (
        <AgentRequestBody req={req} />
      ) : req.kind === "unknown" ? (
        <pre className="out-box ap-code">{JSON.stringify(req.input, null, 2)}</pre>
      ) : nativeGit ? (
        <pre className="out-box ap-code">{JSON.stringify(req.input, null, 2)}</pre>
      ) : edit ? (
        req.preview?.diff != null ? <DiffView diff={req.preview.diff} max={160} /> : null
      ) : (
        <div className="cmd-line ap-cmd"><span className="ps">$</span>{req.input.command}</div>
      )}
      {denying ? (
        <form
          className="ap-deny"
          onSubmit={(e) => {
            e.preventDefault();
            deny();
          }}
        >
          <input
            ref={reasonRef}
            className="input"
            placeholder={tr("O que o agente deve fazer em vez disso? (opcional)")}
            aria-label={tr("Motivo")}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDenying(false);
              }
            }}
          />
          <button type="submit" className="btn danger">{tr("Negar")}</button>
        </form>
      ) : (
        <div className="ap-actions">
          <button type="button" className="ap-opt primary" onClick={() => answerApproval("allow")}>
            <kbd>1</kbd>{tr("Permitir")}</button>
          {alwaysLabel && (
            <button type="button" className="ap-opt" onClick={() => answerApproval("always")}>
              <kbd>2</kbd>
              <span>{alwaysLabel}</span>
            </button>
          )}
          <button type="button" className="ap-opt" onClick={() => setDenying(true)}>
            <kbd>3</kbd>{tr("Negar e explicar")}</button>
        </div>
      )}
    </div>
  );
}

/** What an agent action will do, beyond the one-line summary. */
function AgentRequestBody({ req }: { req: ApprovalRequest }) {
  useLanguage();
  const a = req.input || {};
  if (req.name === "run_code" || req.name === "write_file")
    return <pre className="out-box ap-code">{(req.name === "run_code" ? a.code : a.content) || ""}</pre>;
  if (req.name === "create_task") return <div className="ap-detail">{a.instructions}</div>;
  if (req.name === "fetch_url") return <div className="ap-detail"><code>{a.url}</code></div>;
  return null;
}

// ------------------------------------------------------------------ thread segmentation

export type Segment =
  | { kind: "msg"; m: Message }
  | { kind: "prose"; m: Message }
  | { kind: "activity"; key: string; items: Item[] }
  | { kind: "changes"; m: Message; edits: ToolResult[] }
  | { kind: "steer"; key: string; texts: string[] }
  | { kind: "files"; key: string; m: Message };

/** Splits a turn of a code session into messages, prose, runs of tool calls and the changes card. */
export function codeSegments(msgs: Message[], toolLive: Record<string, ToolLive>): Segment[] {
  const results = new Map<string, ToolResult>();
  for (const m of msgs) if (m.role === "tool_result") for (const r of m.tool_results || []) results.set(r.id, r);
  const out: Segment[] = [];
  let group: Item[] | null = null;
  const edits: ToolResult[] = [];
  for (const m of msgs) {
    if (m.role === "tool_call") {
      if (m.content?.trim()) {
        group = null;
        out.push({ kind: "prose", m });
      }
      for (const call of m.tool_calls || []) {
        const lv = toolLive[call.id];
        const result = results.get(call.id) || lv?.result;
        if (!group) {
          group = [];
          out.push({ kind: "activity", key: call.id, items: group });
        }
        group.push({ call, result, live: lv });
        if (result && isEdit(call.name) && !result.is_error && result.meta?.diff != null) edits.push(result);
      }
    } else if (m.role === "tool_result") {
      for (const r of m.tool_results || [])
        if (r.meta?.steer?.length) {
          group = null;
          out.push({ kind: "steer", key: "st" + r.id, texts: r.meta.steer });
        }
      // files the agent made on its computer, ready to download
      if (m.attachments?.length) {
        group = null;
        out.push({ kind: "files", key: "f" + m.id, m });
      }
    } else {
      group = null;
      out.push({ kind: "msg", m });
      if (m.role === "assistant" && m.status !== "streaming" && edits.length) out.push({ kind: "changes", m, edits: [...edits] });
    }
  }
  return out;
}

/** What the user sent while the agent worked (delivered with a tool result). */
export function SteerNote({ texts }: { texts: string[] }) {
  useLanguage();
  return (
    <div className="steer-note">
      <span className="h">{tr("Enviado durante a execução")}</span>
      {texts.map((t, i) => (
        <div key={i} className="b">{t}</div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ end-of-turn changes

export function ChangesCard({ m, edits }: { m: Message; edits: ToolResult[] }) {
  useLanguage();
  const files = useMemo(() => {
    const map = new Map<string, { path: string; added: number; removed: number; created: boolean; diffs: string[] }>();
    for (const e of edits) {
      const p = e.meta.path || "?";
      const f = map.get(p) || { path: p, added: 0, removed: 0, created: !!e.meta.created, diffs: [] };
      f.added += e.meta.added || 0;
      f.removed += e.meta.removed || 0;
      f.diffs.push(e.meta.diff || "");
      map.set(p, f);
    }
    return [...map.values()];
  }, [edits]);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const shown = all ? files : files.slice(0, 4);
  const undo = async () => {
    const ok = await confirmDialog({
      title: tr("Desfazer as alterações deste turno?"),
      body: tr("{0} ao conteúdo de antes deste turno; arquivos criados são apagados. Mudanças feitas depois nesses arquivos também se perdem.", files.length === 1 ? tr("O arquivo volta") : tr("Os {0} arquivos voltam", files.length)),
      confirm: tr("Desfazer"),
      danger: true,
    });
    if (ok) undoTurn(m);
  };
  return (
    <div className="changes">
      <div className="ch-head">
        <Ic name="file" />
        <span className="lbl">{files.length === 1 ? tr("Editou 1 arquivo") : tr("Editou {0} arquivos", files.length)}</span>
        <div className="grow" />
        {m.undoable && (
          <button type="button" className="ch-undo" onClick={undo}>
            {tr("Desfazer")}</button>
        )}
        <Stat added={added} removed={removed} />
      </div>
      {shown.map((f) => (
        <div key={f.path} className={cx("ch-file", open === f.path && "is-open")}>
          <button type="button" className="ch-row" aria-expanded={open === f.path} onClick={() => setOpen(open === f.path ? null : f.path)}>
            <Icon name={f.created ? "new" : "edit"} />
            <span className="p" title={f.path}>{f.path}</span>
            <Stat added={f.added} removed={f.removed} />
            <Ic name="chevron-right" className="chev" />
          </button>
          {open === f.path && f.diffs.map((d, i) => <DiffView key={i} diff={d} />)}
        </div>
      ))}
      {files.length > shown.length && (
        <button type="button" className="ch-row ch-more" onClick={() => setAll(true)}>
          {tr("Mostrar mais ")}{files.length - shown.length}
        </button>
      )}
    </div>
  );
}
