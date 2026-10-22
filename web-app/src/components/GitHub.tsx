import { tr, translateLabel, useLanguage } from "../lib/i18n";
import { useEffect, useState } from "react";
import { api, type GitHubStatus } from "../api";
import { Icon } from "../lib/icons";
import { openExternal } from "../lib/util";
import { confirmDialog, toast } from "../state/ui";

const EMPTY: GitHubStatus = { connected: false, account: null, available: false, detail: "Verificando cofre seguro…" };

export function GitHubSettings() {
  useLanguage();
  const [status, setStatus] = useState(EMPTY);
  const [gitInstalled, setGitInstalled] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const res = await api.github();
      setStatus(res.github);
      setGitInstalled(res.git_installed);
    } catch (e: any) {
      toast(e.message);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    try {
      const res = await api.githubConnect(token.trim());
      setStatus(res.github);
      toast(tr("GitHub conectado{0}", res.github.account ? `: ${res.github.account}` : ""));
    } catch (err: any) {
      toast(err.message, { duration: 7000 });
    } finally {
      setToken("");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirmDialog({
      title: tr("Desconectar GitHub?"),
      body: tr("O token será removido do cofre seguro do sistema. Remotes e repositórios publicados não serão alterados."),
      confirm: tr("Desconectar"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.githubDisconnect();
      setStatus(res.github);
      toast(tr("GitHub desconectado"));
    } catch (e: any) {
      toast(e.message, { duration: 7000 });
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    setBusy(true);
    try {
      const res = await api.githubValidate();
      setStatus(res.github);
      toast(translateLabel(res.github.detail));
    } catch (e: any) {
      toast(e.message, { duration: 7000 });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>GitHub</h3>
      <p className="lead">
        {tr("Conecte o GitHub para que os agentes criem repositórios, façam push e publiquem releases com artefatos. Os agentes recebem apenas o resultado das operações; a credencial fica no cofre seguro do sistema.")}</p>

      <div className="prov rt-card gh-card is-open" data-state={status.connected ? "connected" : status.available ? "setup_required" : "error"}>
        <div className="prov-head gh-head">
          <span className={"dot " + (status.connected ? "ok" : status.available ? "warn" : "err")} />
          <Icon name="plug" />
          <span className="n">{tr("Conta GitHub")}</span>
          <span className="d">{status.connected ? tr("Conectado{0}", status.account ? ` · ${status.account}` : "") : status.available ? tr("Desconectado") : tr("Cofre indisponível")}</span>
        </div>
        <div className="prov-body gh-body">
          <p className="rt-note">{translateLabel(status.detail)}</p>
          <div className="gh-host-state">
            <span className={"dot " + (gitInstalled ? "ok" : "warn")} />
            {tr("Git local: ")}{gitInstalled ? tr("detectado no host") : tr("não encontrado no PATH do CEU")}
          </div>

          {!status.connected && status.available && (
            <form className="gh-auth-form" onSubmit={connect}>
              <label htmlFor="gh-token">{tr("Token pessoal do GitHub")}</label>
              <input
                id="gh-token"
                className="input"
                type="password"
                value={token}
                autoComplete="off"
                spellCheck={false}
                placeholder={tr("github_pat_… ou ghp_…")}
                onChange={(e) => setToken(e.target.value)}
              />
              <div className="gh-form-actions">
                <button type="button" className="btn ghost" onClick={() => openExternal("https://github.com/settings/personal-access-tokens/new")}>
                  {tr("Criar token no GitHub")}</button>
                <button type="submit" className="btn primary" disabled={busy || !token.trim()}>
                  {busy ? tr("Conectando…") : tr("Conectar")}
                </button>
              </div>
              <p className="gh-help">
                {tr("Para token clássico, use o escopo ")}<code>repo</code>{tr(". Para token de granularidade fina, conceda ")}<code>Repository creation: write</code> {tr("(ou ")}<code>Administration: write</code>{tr(") para criar repositórios e ")}<code>Contents: write</code> {tr("para push, tags, releases e anexos; escolha acesso a todos os repositórios para operar também nos novos projetos. A organização pode exigir aprovação do token.")}</p>
              <p className="gh-help">{tr("O token é enviado ao CEU para validação e salvo no cofre do sistema operacional. Ele não é gravado em conversas, prompts, logs, banco SQLite ou arquivos do projeto.")}</p>
            </form>
          )}

          {status.connected && (
            <div className="gh-form-actions">
              <button type="button" className="btn" disabled={busy} onClick={validate}>{tr("Validar conexão")}</button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void disconnect()}>{tr("Desconectar")}</button>
            </div>
          )}
          {!status.available && <button type="button" className="btn" onClick={() => void refresh()}>{tr("Verificar cofre novamente")}</button>}
        </div>
      </div>
    </>
  );
}
