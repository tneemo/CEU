// Settings → Runtimes e agentes: the hub where the Code runtimes that depend on external tools
// get installed and logged in (server/integrations.py owns the lifecycle; this only renders
// snapshots and triggers actions). Every login is the tool's official one; tokens never reach
// the client.
import { useEffect, useState } from "react";
import { api, type Integration, type IntegrationState, type LoginMethod } from "../api";
import { Ic, Icon } from "../lib/icons";
import { copyText, cx, openExternal, relTime } from "../lib/util";
import { integrationAction, loadIntegrations, providersChanged } from "../state/actions";
import { useApp } from "../state/store";
import { confirmDialog, toast } from "../state/ui";

export const STATE_LABEL: Record<IntegrationState, string> = {
  unconfigured: "Não configurado",
  setup_required: "Configuração pendente",
  authenticating: "Autenticando…",
  connected: "Conectado",
  error: "Erro",
};

const DOT: Record<IntegrationState, string> = {
  unconfigured: "",
  setup_required: "warn",
  authenticating: "busy",
  connected: "ok",
  error: "err",
};

/** What the header button of a card says: Configurar (install) / Conectar (login). */
function headAction(i: Integration) {
  if (i.job) return "Cancelar";
  if (i.state === "connected") return null;
  return i.installed ? "Conectar" : "Configurar";
}

export function RuntimesHub({ focus }: { focus?: string }) {
  const integrations = useApp((s) => s.integrations);
  const [open, setOpen] = useState<string | null>(focus || null);
  // opening the hub re-checks every integration (they may have changed outside CEU)
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    loadIntegrations(true).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (focus) setOpen(focus);
  }, [focus]);
  const card = (i: Integration) => <IntegrationCard key={i.id} i={i} open={open === i.id} toggle={() => setOpen((o) => (o === i.id ? null : i.id))} />;
  return (
    <>
      <h3>Runtimes e agentes</h3>
      <p className="lead">
        Os runtimes do Code que usam o harness de outro fornecedor. O CEU instala cada ferramenta e conduz o login oficial dela; as credenciais ficam
        no armazenamento da própria ferramenta. O CEU SDK não depende de nada daqui.
      </p>
      <div className="rt-hub-bar">
        <span>{checking ? "Verificando…" : integrations.length ? `Verificado ${relTime(Math.min(...integrations.map((i) => i.checked_at)) * 1000)}` : ""}</span>
        <button
          type="button"
          className="btn ghost"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            loadIntegrations(true).finally(() => setChecking(false));
          }}
        >
          <Icon name="retry" />
          Verificar de novo
        </button>
      </div>
      <h4 className="rt-group">SDKs · harness oficial conduzido pelo CEU</h4>
      {integrations.filter((i) => i.kind === "sdk").map(card)}
      <h4 className="rt-group">CEU REDIR · agentes externos supervisionados</h4>
      {integrations.filter((i) => i.kind === "cli").map(card)}
      {!integrations.length && <p className="lead">{checking ? "Carregando…" : "Nenhuma integração disponível."}</p>}
    </>
  );
}

function IntegrationCard({ i, open, toggle }: { i: Integration; open: boolean; toggle: () => void }) {
  const act = headAction(i);
  return (
    <div className={cx("prov rt-card", open && "is-open")} data-state={i.state}>
      <div
        className="prov-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={"dot " + DOT[i.state]} />
        <span className="n">{i.name}</span>
        <span className="d">{i.detail}</span>
        <span className={"rt-pill is-" + i.state}>{STATE_LABEL[i.state]}</span>
        {act && (
          <button
            type="button"
            className={cx("btn", act !== "Cancelar" && "primary")}
            onClick={(e) => {
              e.stopPropagation();
              if (act === "Cancelar") integrationAction(i.id, "cancel");
              else if (!open) toggle();
            }}
          >
            {act}
          </button>
        )}
        <Ic name="chevron-right" className="chev" />
      </div>
      <div className="prov-body">{open && <CardBody i={i} />}</div>
    </div>
  );
}

function CardBody({ i }: { i: Integration }) {
  const [relogin, setRelogin] = useState(false);
  const showLogin = i.installed && !i.job && (i.state !== "connected" || relogin);
  return (
    <>
      <p className="rt-note">{i.auth_note}</p>
      {i.error && !i.job && (
        <div className="rt-error" role="alert">
          <b>Algo deu errado</b>
          <pre>{i.error}</pre>
        </div>
      )}
      {i.job && <JobPanel i={i} />}
      <ul className="rt-reqs">
        {i.requirements.map((r) => (
          <li key={r.id} className={r.ok ? "ok" : "miss"}>
            <Icon name={r.ok ? "check" : "close"} />
            <span>
              <b>{r.label}</b> {r.detail}
            </span>
          </li>
        ))}
        {i.installed && i.version && <li className="dim">Versão: {i.version}</li>}
      </ul>
      {!i.job && i.install_steps.length > 0 && <InstallPanel i={i} />}
      {i.state === "connected" && i.account && (
        <div className="rt-account">
          <span>{i.method}</span>
          {(i.account.email || i.account.provider) && <b>{i.account.email || i.account.provider}</b>}
          {i.account.key_hint && <code>{i.account.key_hint}</code>}
          {(i.account.plan || i.account.subscriptionType) && <span className="dim">plano {i.account.plan || i.account.subscriptionType}</span>}
          {i.account.orgName && <span className="dim">{i.account.orgName}</span>}
        </div>
      )}
      {i.state === "connected" && !i.account && i.method && <div className="rt-account"><span>{i.method}</span></div>}
      {showLogin && <LoginPanel i={i} />}
      <div className="actions-row">
        {i.actions.includes("validate") && (
          <button type="button" className="btn" onClick={() => integrationAction(i.id, "validate").then((x) => x?.state === "connected" && toast(`${i.name}: sessão válida`))}>
            <Icon name="check" />
            Validar sessão
          </button>
        )}
        {i.actions.includes("relogin") && !relogin && (
          <button type="button" className="btn" onClick={() => setRelogin(true)}>
            <Icon name="retry" />
            Reautenticar
          </button>
        )}
        {i.actions.includes("logout") && (
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              const shared = i.group === "codex" ? " O Codex SDK e o Codex CLI usam a mesma conta: os dois serão desconectados." : "";
              const ok = await confirmDialog({
                title: `Sair de ${i.name}?`,
                body: (i.id === "claude_sdk" ? "O SDK deixa de usar esta chave; o provedor Anthropic continua salvo." : "Isso encerra o login na própria ferramenta.") + shared,
                confirm: "Sair",
                danger: true,
              });
              if (ok) integrationAction(i.id, "logout");
            }}
          >
            Sair
          </button>
        )}
        <div className="grow" />
        {i.docs_url && (
          <button type="button" className="btn ghost" onClick={() => openExternal(i.docs_url)}>
            <Icon name="external" />
            Documentação
          </button>
        )}
        {i.actions.includes("refresh") && (
          <button type="button" className="btn ghost" onClick={() => integrationAction(i.id, "refresh")}>
            Verificar
          </button>
        )}
      </div>
    </>
  );
}

function JobPanel({ i }: { i: Integration }) {
  const job = i.job!;
  return (
    <div className="rt-job" aria-live="polite">
      <div className="rt-job-h">
        <span className="spin" aria-hidden />
        <b>{job.label}</b>
        <span className="grow" />
        <button type="button" className="btn" onClick={() => integrationAction(i.id, "cancel")}>
          Cancelar
        </button>
      </div>
      {job.message && <p>{job.message}</p>}
      {job.user_code && (
        <div className="rt-code">
          <code>{job.user_code}</code>
          <button type="button" className="btn ghost" onClick={() => copyText(job.user_code!).then(() => toast("Código copiado"))}>
            <Icon name="copy" />
            Copiar
          </button>
        </div>
      )}
      {job.url && (
        <button type="button" className="btn ghost rt-link" onClick={() => openExternal(job.url!)}>
          <Icon name="external" />
          Abrir a página de login de novo
        </button>
      )}
      {job.log.length > 0 && <pre className="rt-log">{job.log.join("\n")}</pre>}
    </div>
  );
}

function InstallPanel({ i }: { i: Integration }) {
  const blocked = i.install_steps.find((s) => s.blocked)?.blocked;
  return (
    <div className="rt-install">
      {i.install_steps.map((s) => (
        <div key={s.id} className="rt-step">
          <b>{s.label}</b>
          <code>{s.command}</code>
        </div>
      ))}
      {blocked ? (
        <p className="rt-blocked">{blocked}</p>
      ) : (
        <div className="actions-row">
          <button type="button" className="btn primary" onClick={() => integrationAction(i.id, "install")}>
            <Icon name="download" />
            Instalar
          </button>
          <span className="dim">O CEU executa o comando oficial acima e mostra a saída aqui.</span>
        </div>
      )}
    </div>
  );
}

function LoginPanel({ i }: { i: Integration }) {
  const [form, setForm] = useState<string | null>(null);
  if (!i.login_methods.length) return null;
  const primary = i.login_methods.find((m) => m.primary) || i.login_methods[0];
  const others = i.login_methods.filter((m) => m !== primary);
  const start = (m: LoginMethod) => (m.fields?.length ? setForm(m.id) : integrationAction(i.id, "login", { method: m.id }));
  const formMethod = i.login_methods.find((m) => m.id === form);
  return (
    <div className="rt-login">
      {formMethod ? (
        <LoginForm i={i} m={formMethod} onCancel={() => setForm(null)} />
      ) : (
        <>
          <div className="rt-method primary">
            <button type="button" className="btn primary" onClick={() => start(primary)}>
              {primary.label}
            </button>
            {primary.detail && <span>{primary.detail}</span>}
          </div>
          {others.map((m) => (
            <div key={m.id} className="rt-method">
              <button type="button" className="btn" onClick={() => start(m)}>
                {m.label}
              </button>
              {m.detail && <span>{m.detail}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function LoginForm({ i, m, onCancel }: { i: Integration; m: LoginMethod; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((m.fields || []).map((f) => [f.id, f.options?.[0]?.id || ""])),
  );
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const providerField = m.fields?.find((f) => f.options);
  const noProviders = !!providerField && !providerField.options!.length;

  const submit = async () => {
    setBusy(true);
    const params = { ...values };
    try {
      // Claude SDK without an Anthropic provider yet: the key is saved as a provider first
      // (CEU's own key storage), then chosen for the SDK.
      if (providerField && (noProviders || values[providerField.id] === "__new")) {
        if (!newKey.trim()) throw new Error("Cole a chave de API da Anthropic.");
        const res = await api.createProvider({ preset: "anthropic", api_key: newKey.trim() });
        await providersChanged();
        if (res.error) throw new Error(`A chave foi recusada: ${res.error}`);
        params[providerField.id] = res.provider.id;
      }
      const after = await integrationAction(i.id, "login", { method: m.id, params });
      if (after) onCancel();
    } catch (e: any) {
      toast(e.message, { duration: 6000 });
    }
    setBusy(false);
  };

  return (
    <form
      className="rt-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {m.detail && <p className="rt-note">{m.detail}</p>}
      {(m.fields || []).map((f) =>
        f.options ? (
          <div key={f.id}>
            {!noProviders && (
              <>
                <label>{f.label}</label>
                <select className="input" value={values[f.id]} onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}>
                  {f.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                  <option value="__new">Adicionar outra chave…</option>
                </select>
              </>
            )}
            {(noProviders || values[f.id] === "__new") && (
              <>
                <label>Chave de API da Anthropic</label>
                <input className="input" type="password" autoComplete="off" spellCheck={false} autoFocus placeholder="sk-ant-…" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
                <p className="rt-note">A chave fica no banco local do CEU como um provedor Anthropic (também usável no chat) e nunca volta ao navegador.</p>
              </>
            )}
          </div>
        ) : (
          <div key={f.id}>
            <label>{f.label}</label>
            <input
              className="input"
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={values[f.id] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            />
          </div>
        ),
      )}
      <div className="actions-row">
        <button type="submit" className="btn primary" disabled={busy}>
          Conectar
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Voltar
        </button>
      </div>
    </form>
  );
}
