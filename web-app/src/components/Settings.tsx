import { getLocale, resolveLanguage, tr, useLanguage } from "../lib/i18n";
// Settings dialog. Structure follows claude.ai and chatgpt.com settings (see docs/referencias-claude-chatgpt.md):
// a searchable navigation in groups, one section per area, changes saved as they happen.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Level, type Memory, type Provider, type Settings as SettingsT, type StorageReport, type UsageReport } from "../api";
import { Ic, Icon } from "../lib/icons";
import { cx, debounce, download, formatSize, kbd, relTime } from "../lib/util";
import { ACCENTS, allDeleted, applySettings, loadHomeSuggestions, loadIntegrations, newChat, openConversation, providersChanged, refreshConvs, requestNotifications, setArchived } from "../state/actions";
import { allModels, S, setS, useApp } from "../state/store";
import { closeDialog, confirmDialog, openMenu, openSettings, toast, useUi } from "../state/ui";
import { DialogShell } from "./Overlay";
import { RuntimesHub } from "./Runtimes";
import { GitHubSettings } from "./GitHub";

interface Section {
  id: string;
  label: string;
  icon: string;
  group: string;
  /** extra words the settings search matches (field titles, synonyms) */
  keywords: string;
}

const SECTIONS = (): Section[] => ([
  { id: "general", label: tr("Geral"), icon: "sliders", group: tr("Pessoais"), keywords: tr("idioma língua envio enter modelo padrão títulos temporária") },
  { id: "appearance", label: tr("Aparência"), icon: "palette", group: tr("Pessoais"), keywords: tr("tema escuro claro modo destaque cor acento fonte serif mono tamanho texto código largura movimento animação espaço partículas") },
  { id: "personalization", label: tr("Personalização"), icon: "user", group: tr("Pessoais"), keywords: tr("instruções personalizadas apelido nome ocupação sobre você estilo tom cordialidade entusiasmo títulos listas emoji personalidade") },
  { id: "memory", label: tr("Memória"), icon: "memory", group: tr("Pessoais"), keywords: tr("memórias lembrar contexto histórico") },
  { id: "notifications", label: tr("Notificações"), icon: "bell", group: tr("Pessoais"), keywords: tr("notificação aviso som conclusão resposta") },
  { id: "voice", label: tr("Voz"), icon: "voice", group: tr("Pessoais"), keywords: tr("voz leitura ler em voz alta velocidade fala") },
  { id: "providers", label: tr("Provedores"), icon: "plug", group: tr("Modelos"), keywords: tr("api chave anthropic openai chatgpt codex openrouter local ollama llama lm studio modelos") },
  { id: "runtimes", label: tr("Runtimes e agentes"), icon: "cube", group: tr("Modelos"), keywords: tr("code runtime sdk codex claude antigravity agy cli redir agente externo login conectar instalar autenticação conta") },
  { id: "github", label: "GitHub", icon: "plug", group: tr("Modelos"), keywords: tr("git github token autenticação conectar desconectar repositório publicação release push") },
  { id: "capabilities", label: tr("Recursos"), icon: "tools", group: tr("Modelos"), keywords: tr("ferramentas execução código python bash sandbox arquivos rede wsl") },
  { id: "usage", label: tr("Uso"), icon: "gauge", group: tr("Sistema"), keywords: tr("tokens estatísticas consumo mensagens por modelo") },
  { id: "shortcuts", label: tr("Teclado"), icon: "keyboard", group: tr("Sistema"), keywords: tr("atalhos teclado tecla") },
  { id: "data", label: tr("Dados"), icon: "database", group: tr("Sistema"), keywords: tr("exportar arquivar arquivadas excluir apagar armazenamento backup json") },
]);

/** Old section ids still used by callers. */
const ALIASES: Record<string, string> = { instructions: "personalization" };

export const SHORTCUTS = (): [string, string][] => ([
  [tr("Nova conversa (ou sessão, no Code)"), "Ctrl ⇧ O"],
  [tr("Ir para Chat / Code"), "Ctrl ⇧ 1 / Ctrl ⇧ 2"],
  [tr("Buscar e comandos"), "Ctrl K"],
  [tr("Trocar modelo"), "Ctrl ."],
  [tr("Alternar barra lateral"), "Ctrl B"],
  [tr("Conversa anterior / seguinte"), "Alt ↑ / Alt ↓"],
  [tr("Focar o campo de mensagem"), "⇧ Esc"],
  [tr("Editar a última mensagem"), tr("↑ (campo vazio)")],
  [tr("Interromper a resposta"), "Esc"],
  [tr("Copiar a última resposta"), "Ctrl ⇧ C"],
  [tr("Renomear a conversa"), "F2"],
  [tr("Excluir a conversa"), "Ctrl ⇧ ⌫"],
  [tr("Menu da conversa: fixar, renomear, exportar, arquivar, excluir"), "P / R / E / A / D"],
  [tr("Configurações"), "Ctrl ,"],
  [tr("Atalhos de teclado"), "Ctrl /"],
]);

/** provider id → last connection error, shown inside its card (survives re-renders) */
const lastErrors = new Map<string, string>();

let flashSaved = () => {};

async function save(patch: Partial<SettingsT>) {
  const previousLanguage = S().settings.language;
  // optimistic: the UI reflects the change immediately, the server confirms
  if (patch.language) setS({ homeSuggestions: [] });
  setS((st) => ({ settings: { ...st.settings, ...patch } }));
  applySettings();
  try {
    setS({ settings: await api.settings(patch) });
    applySettings();
    if (patch.language) void loadHomeSuggestions();
    flashSaved();
  } catch (e: any) {
    if (patch.language && S().settings.language === patch.language) {
      setS((st) => ({ settings: { ...st.settings, language: previousLanguage } }));
      applySettings();
    }
    toast(e.message);
  }
}


// ------------------------------------------------------------------ controls

function Seg<T extends string | number>({ options, value, onChange, label }: { options: [T, string][]; value: T; onChange: (v: T) => void; label?: string }) {
  useLanguage();
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([ov, text]) => (
        <button key={String(ov)} type="button" className={String(ov) === String(value) ? "is-on" : ""} role="radio" aria-checked={String(ov) === String(value)} onClick={() => onChange(ov)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  useLanguage();
  const [v, setV] = useState(on);
  useEffect(() => setV(on), [on]);
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-label={label}
      aria-checked={v}
      disabled={disabled}
      onClick={() => {
        setV(!v);
        onChange(!v);
      }}
    />
  );
}

function Row({ title, desc, children, badge, stack }: { title: string; desc?: ReactNode; children?: ReactNode; badge?: string; stack?: boolean }) {
  useLanguage();
  return (
    <div className={cx("field-row", stack && "is-stack")}>
      <div className="l">
        <b>
          {title}
          {badge && <em className="badge">{badge}</em>}
        </b>
        {desc && <span>{desc}</span>}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  useLanguage();
  return (
    <section className="field-group">
      {title && <h4>{title}</h4>}
      <div className="card">{children}</div>
    </section>
  );
}

/** Dropdown with a description per option (ChatGPT's "Estilo e tom" pattern), built on the app menu. */
function MenuSelect<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string; sub?: string }[]; onChange: (v: T) => void; label: string }) {
  useLanguage();
  const cur = options.find((o) => o.v === value) || options[0];
  return (
    <button
      type="button"
      className="menu-select"
      aria-label={label}
      aria-haspopup="menu"
      onClick={(e) =>
        openMenu({
          anchor: e.currentTarget,
          placement: "bottom-end",
          className: "menu-select-list",
          items: options.map((o) => ({ label: o.label, sub: o.sub, checked: o.v === value, onSelect: () => onChange(o.v) })),
        })
      }
    >
      <span>{cur.label}</span>
      <Icon name="chevron-down" />
    </button>
  );
}

function ModelSelect({ value, allowSame, onChange }: { value: string | null; allowSame?: boolean | string; onChange: (v: string | null) => void }) {
  useLanguage();
  const providers = useApp((s) => s.providers);
  const models = allModels(providers);
  return (
    <select className="select" value={value || ""} onChange={(e) => onChange(e.target.value || null)}>
      {allowSame && <option value="">{allowSame === true ? tr("O mesmo da conversa") : allowSame}</option>}
      {!allowSame && !models.length && <option value="">{tr("Nenhum modelo")}</option>}
      {!allowSame && models.length > 0 && !models.some((m) => m.ref === value) && <option value="">—</option>}
      {models.map((m) => (
        <option key={m.ref} value={m.ref}>
          {m.name} — {m.provider.name}
        </option>
      ))}
    </select>
  );
}

function Stepper({ value, min, max, onChange, unit }: { value: number; min: number; max: number; onChange: (v: number) => void; unit?: string }) {
  useLanguage();
  return (
    <div className="stepper">
      <button type="button" aria-label={tr("Diminuir")} disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span>
        {value}
        {unit && <small>{unit}</small>}
      </span>
      <button type="button" aria-label={tr("Aumentar")} disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

/** Text setting saved as the user types (debounced), like both references. */
function TextSetting({ k, rows, placeholder, max }: { k: "instructions" | "nickname" | "occupation" | "about"; rows?: number; placeholder?: string; max?: number }) {
  useLanguage();
  const initial = useApp.getState().settings[k];
  const persist = useMemo(() => debounce((v: string) => save({ [k]: v }), 500), [k]);
  if (!rows)
    return <input className="input wide" defaultValue={initial} placeholder={placeholder} maxLength={max} onChange={(e) => persist(e.target.value)} />;
  return <textarea className="textarea" rows={rows} defaultValue={initial} placeholder={placeholder} maxLength={max} onChange={(e) => persist(e.target.value)} />;
}

// ------------------------------------------------------------------ Geral

function General() {
  useLanguage();
  const s = useApp((st) => st.settings);
  return (
    <>
      <h3>{tr("Geral")}</h3>
      <p className="lead">{tr("Comportamento do aplicativo. As alterações são salvas automaticamente.")}</p>
      <Group>
        <Row title={tr("Idioma")} desc={tr("Idioma da interface. O inglês é o padrão.")}>
          <select className="select" value={resolveLanguage(s.language)} onChange={(e) => save({ language: e.target.value as SettingsT["language"] })} aria-label={tr("Idioma da interface")}>
            <option value="en">English</option>
            <option value="pt-BR">Português (Brasil)</option>
          </select>
        </Row>
        <Row title={tr("Envio")} desc={tr("Com Ctrl+Enter, Enter sempre insere uma nova linha.")}>
          <select className="select" value={s.send_key} onChange={(e) => save({ send_key: e.target.value as SettingsT["send_key"] })}>
            <option value="enter">{tr("Enter envia")}</option>
            <option value="ctrl-enter">{kbd("Ctrl")}{tr("+Enter envia")}</option>
          </select>
        </Row>
      </Group>
      <Group title={tr("Conversas")}>
        <Row title={tr("Modelo padrão")} desc={tr("Usado em conversas novas.")}>
          <ModelSelect value={s.default_model} onChange={(v) => save({ default_model: v })} />
        </Row>
        <Row title={tr("Modelo para títulos")} desc={tr("Gera o título de cada conversa depois da primeira resposta.")}>
          <ModelSelect value={s.title_model} allowSame onChange={(v) => save({ title_model: v })} />
        </Row>
        <Row title={tr("Modelo para sugestões")} desc={tr("Escreve os três cards de início: os de cada agente, a partir do propósito dele, e os da conversa nova, a partir do seu histórico. Um modelo rápido e barato basta.")}>
          <ModelSelect value={s.suggestion_model} allowSame={tr("O do agente / o padrão")} onChange={(v) => save({ suggestion_model: v })} />
        </Row>
        <Row title={tr("Começar em conversa temporária")} desc={tr("Novas conversas não entram no histórico e são apagadas quando você sai delas. Dá para alternar no ícone do topo.")}>
          <Switch on={s.temporary_default} onChange={(v) => save({ temporary_default: v })} />
        </Row>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Aparência

function ModeCard({ mode, label, on, onClick }: { mode: "system" | "light" | "dark"; label: string; on: boolean; onClick: () => void }) {
  useLanguage();
  return (
    <button type="button" className={cx("mode-card", on && "is-on")} role="radio" aria-checked={on} onClick={onClick}>
      <span className={"mini mini-" + mode} aria-hidden="true">
        <i className="sb" />
        <i className="l1" />
        <i className="l2" />
        <i className="l3" />
      </span>
      <span>{label}</span>
    </button>
  );
}

function Appearance() {
  useLanguage();
  const s = useApp((st) => st.settings);
  return (
    <>
      <h3>{tr("Aparência")}</h3>
      <p className="lead">{tr("Cores, tipografia e movimento. Aplicados na hora.")}</p>
      <Group title={tr("Estilo visual")}>
        <div className="mode-cards" role="radiogroup" aria-label={tr("Modo")}>
          <ModeCard mode="system" label={tr("Sistema")} on={s.theme === "system"} onClick={() => save({ theme: "system" })} />
          <ModeCard mode="light" label={tr("Claro")} on={s.theme === "light"} onClick={() => save({ theme: "light" })} />
          <ModeCard mode="dark" label={tr("Escuro")} on={s.theme === "dark"} onClick={() => save({ theme: "dark" })} />
        </div>
        <Row title={tr("Destaque")} desc={tr("Cor de links, seleção e indicadores.")}>
          <div className="swatches" role="radiogroup" aria-label={tr("Destaque")}>
            {Object.entries(ACCENTS()).map(([id, a]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={s.accent === id}
                aria-label={a.label}
                data-tip={a.label}
                className={cx("swatch", s.accent === id && "is-on")}
                style={{ "--sw-d": a.dark, "--sw-l": a.light } as React.CSSProperties}
                onClick={() => save({ accent: id as SettingsT["accent"] })}
              />
            ))}
          </div>
        </Row>
      </Group>
      <Group title={tr("Texto")}>
        <Row title={tr("Fonte da conversa")} desc={tr("Aplica-se às mensagens.")}>
          <Seg label={tr("Fonte da conversa")} options={[["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["system", tr("Sistema")]]} value={s.chat_font} onChange={(v) => save({ chat_font: v })} />
        </Row>
        <Row title={tr("Tamanho do texto")} desc={tr("Mensagens e campo de texto.")}>
          <Seg label={tr("Tamanho do texto")} options={[[14, tr("Pequeno")], [15, tr("Médio")], [16, tr("Grande")], [17, tr("Extra grande")]]} value={s.font_size} onChange={(v) => save({ font_size: Number(v) })} />
        </Row>
        <Row title={tr("Tamanho do código")} desc={tr("Blocos de código nas respostas.")}>
          <Stepper value={s.code_font_size} min={11} max={18} unit="px" onChange={(v) => save({ code_font_size: v })} />
        </Row>
        <Row title={tr("Largura da conversa")} desc={tr("Largura máxima das mensagens e do campo de texto.")}>
          <Seg label={tr("Largura da conversa")} options={[["narrow", tr("Estreita")], ["medium", tr("Média")], ["wide", tr("Larga")]]} value={s.width} onChange={(v) => save({ width: v })} />
        </Row>
      </Group>
      <Group title={tr("Movimento")}>
        <Row title={tr("Animações")} desc={tr("“Sistema” segue a preferência de movimento reduzido do Windows.")}>
          <Seg label={tr("Animações")} options={[["system", tr("Sistema")], ["reduce", tr("Reduzidas")], ["full", tr("Completas")]]} value={s.motion} onChange={(v) => save({ motion: v })} />
        </Row>
        <Row title={tr("Espaço animado")} desc={tr("Partículas ao fundo que aceleram enquanto um modelo responde.")}>
          <Switch on={s.ambient !== false} onChange={(v) => save({ ambient: v })} />
        </Row>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Personalização

const STYLE_OPTIONS = (): { v: SettingsT["style"]; label: string; sub: string }[] => ([
  { v: "default", label: tr("Padrão"), sub: tr("Estilo e tom de cada modelo") },
  { v: "professional", label: tr("Profissional"), sub: tr("Preciso e refinado") },
  { v: "friendly", label: tr("Amigável"), sub: tr("Acolhedor e conversador") },
  { v: "candid", label: tr("Franco"), sub: tr("Direto e encorajador") },
  { v: "quirky", label: tr("Criativo"), sub: tr("Divertido e inventivo") },
  { v: "efficient", label: tr("Eficiente"), sub: tr("Conciso e simples") },
  { v: "cynical", label: tr("Cético"), sub: tr("Crítico e sarcástico") },
]);

const LEVELS = (): { v: Level; label: string }[] => ([
  { v: "more", label: tr("Mais") },
  { v: "default", label: tr("Padrão") },
  { v: "less", label: tr("Menos") },
]);

function Personalization() {
  useLanguage();
  const s = useApp((st) => st.settings);
  const trait = (k: "warmth" | "enthusiasm" | "headers_lists" | "emoji", title: string) => (
    <Row title={title}>
      <MenuSelect label={title} value={s[k]} options={LEVELS()} onChange={(v) => save({ [k]: v })} />
    </Row>
  );
  return (
    <>
      <h3>{tr("Personalização")}</h3>
      <p className="lead">{tr("Tudo aqui vira instrução de sistema, enviada a qualquer modelo a partir da próxima mensagem. Não muda o que os modelos conseguem fazer.")}</p>
      <Group title={tr("Estilo das respostas")}>
        <Row title={tr("Estilo e tom")} desc={tr("Personalidade básica das respostas.")}>
          <MenuSelect label={tr("Estilo e tom")} value={s.style} options={STYLE_OPTIONS()} onChange={(v) => save({ style: v })} />
        </Row>
        {trait("warmth", tr("Cordialidade"))}
        {trait("enthusiasm", tr("Entusiasmo"))}
        {trait("headers_lists", tr("Títulos e listas"))}
        {trait("emoji", "Emoji")}
      </Group>
      <Group title={tr("Sobre você")}>
        <label className="set-label">{tr("Como o CEU deve te chamar?")}</label>
        <TextSetting k="nickname" placeholder={tr("Apelido")} max={60} />
        <label className="set-label">{tr("Ocupação")}</label>
        <TextSetting k="occupation" placeholder={tr("Ex.: engenheiro de software")} max={120} />
        <label className="set-label">{tr("Mais sobre você")}</label>
        <TextSetting k="about" rows={4} placeholder={tr("Interesses, valores ou preferências que valem para qualquer conversa.")} max={2000} />
      </Group>
      <Group title={tr("Instruções personalizadas")}>
        <TextSetting k="instructions" rows={8} placeholder={tr("Ex.: Responda em português, de forma direta. Sou desenvolvedor Python; prefira exemplos com tipagem.")} max={8000} />
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Memória

function MemoryItem({ m, onChange }: { m: Memory; onChange: () => void }) {
  useLanguage();
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const commit = async () => {
    const v = ref.current!.value.trim();
    setEditing(false);
    if (!v || v === m.content) return;
    try {
      await api.updateMemory(m.id, v);
      onChange();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <li className="memory">
      {editing ? (
        <textarea
          ref={ref}
          className="textarea"
          rows={2}
          defaultValue={m.content}
          autoFocus
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
      ) : (
        <p onDoubleClick={() => setEditing(true)}>{m.content}</p>
      )}
      <span className="when">{relTime(m.updated_at)}</span>
      <button type="button" className="icon-btn" aria-label={tr("Editar memória")} data-tip={tr("Editar")} onClick={() => setEditing(true)}>
        <Icon name="edit" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={tr("Apagar memória")}
        data-tip={tr("Apagar")}
        onClick={async () => {
          await api.deleteMemory(m.id).catch((e) => toast(e.message));
          onChange();
        }}
      >
        <Icon name="trash" />
      </button>
    </li>
  );
}

function MemorySection() {
  useLanguage();
  const s = useApp((st) => st.settings);
  const [mems, setMems] = useState<Memory[] | null>(null);
  const [draft, setDraft] = useState("");
  const load = () => api.memories().then(setMems).catch((e) => toast(e.message));
  useEffect(() => {
    load();
  }, []);
  const add = async () => {
    const v = draft.trim();
    if (!v) return;
    try {
      await api.createMemory(v);
      setDraft("");
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <>
      <h3>{tr("Memória")}</h3>
      <p className="lead">{tr("Fatos que você quer que qualquer modelo leve em conta, em todas as conversas. Ficam só neste computador.")}</p>
      <Group>
        <Row title={tr("Usar memória")} desc={tr("Envia as memórias abaixo junto com as instruções de sistema.")}>
          <Switch on={s.memory_enabled} onChange={(v) => save({ memory_enabled: v })} />
        </Row>
        <Row title={tr("Consultar conversas anteriores")} desc={tr("Permite buscar detalhes relevantes no seu histórico ao responder.")} badge={tr("em breve")}>
          <Switch on={false} disabled onChange={() => {}} />
        </Row>
      </Group>
      <Group title={mems ? tr("Memórias salvas ({0})", mems.length) : tr("Memórias salvas")}>
        <div className={cx("memories", !s.memory_enabled && "is-off")}>
          {mems && !mems.length && <p className="empty-note">{tr("Nenhuma memória ainda. Escreva algo como “Prefiro exemplos em TypeScript”.")}</p>}
          {mems && mems.length > 0 && (
            <ul>
              {mems.map((m) => (
                <MemoryItem key={m.id + m.updated_at} m={m} onChange={load} />
              ))}
            </ul>
          )}
          <div className="memory-add">
            <input
              className="input wide"
              placeholder={tr("Adicionar memória")}
              value={draft}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button type="button" className="btn" disabled={!draft.trim()} onClick={add}>
              {tr("Adicionar")}</button>
          </div>
        </div>
      </Group>
      {mems && mems.length > 0 && (
        <Row title={tr("Apagar todas as memórias")} desc={tr("Remove permanentemente a lista acima.")}>
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              if (!(await confirmDialog({ title: tr("Apagar todas as memórias?"), body: tr("{0} memória(s) serão apagadas.", mems.length), confirm: tr("Apagar"), danger: true }))) return;
              await api.deleteAllMemories().catch((e) => toast(e.message));
              load();
            }}
          >
            <Icon name="trash" />
            {tr("Apagar todas")}</button>
        </Row>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Notificações

function Notifications() {
  useLanguage();
  const s = useApp((st) => st.settings);
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  return (
    <>
      <h3>{tr("Notificações")}</h3>
      <p className="lead">{tr("Avisos quando uma resposta termina e o CEU está em segundo plano.")}</p>
      <Group>
        <Row
          title={tr("Conclusão de respostas")}
          desc={perm === "denied" ? tr("O sistema bloqueou as notificações deste aplicativo. Libere nas configurações do Windows.") : tr("Notificação do sistema quando uma resposta longa terminar.")}
        >
          <Switch
            on={s.notify_done}
            disabled={perm === "unsupported"}
            onChange={async (v) => {
              if (v && !(await requestNotifications())) return save({ notify_done: false });
              save({ notify_done: v });
            }}
          />
        </Row>
        <Row title={tr("Som ao concluir")} desc={tr("Um toque curto, também só com o aplicativo em segundo plano.")}>
          <Switch on={s.notify_sound} onChange={(v) => save({ notify_sound: v })} />
        </Row>
      </Group>
      {s.notify_done && perm === "granted" && (
        <button type="button" className="btn" onClick={() => new Notification("CEU", { body: tr("É assim que o aviso de resposta pronta aparece.") })}>
          <Icon name="bell" />
          {tr("Enviar notificação de teste")}</button>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Voz

function useVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => ("speechSynthesis" in window ? speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const on = () => setVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", on);
    return () => speechSynthesis.removeEventListener("voiceschanged", on);
  }, []);
  return voices;
}

function Voice() {
  useLanguage();
  const s = useApp((st) => st.settings);
  const voices = useVoices();
  const sorted = [...voices].sort((a, b) => Number(b.lang.startsWith(getLocale().slice(0, 2))) - Number(a.lang.startsWith(getLocale().slice(0, 2))) || a.name.localeCompare(b.name));
  const test = () => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(tr("Olá. É assim que as respostas são lidas em voz alta."));
    const v = voices.find((x) => x.name === S().settings.voice_name);
    if (v) u.voice = v;
    else u.lang = getLocale();
    u.rate = S().settings.voice_rate || 1;
    speechSynthesis.speak(u);
  };
  if (!("speechSynthesis" in window))
    return (
      <>
        <h3>{tr("Voz")}</h3>
        <p className="lead">{tr("A síntese de voz não está disponível neste sistema.")}</p>
      </>
    );
  return (
    <>
      <h3>{tr("Voz")}</h3>
      <p className="lead">{tr("Usada em “Ler em voz alta”, nas ações de cada resposta. As vozes são as instaladas no Windows.")}</p>
      <Group>
        <Row title={tr("Voz")}>
          <select className="select" value={s.voice_name} onChange={(e) => save({ voice_name: e.target.value })}>
            <option value="">{tr("Padrão do sistema")}</option>
            {sorted.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} — {v.lang}
              </option>
            ))}
          </select>
        </Row>
        <Row title={tr("Velocidade")}>
          <Seg label={tr("Velocidade")} options={[[0.8, tr("Lenta")], [1, "Normal"], [1.25, tr("Rápida")], [1.5, tr("Muito rápida")]]} value={s.voice_rate} onChange={(v) => save({ voice_rate: Number(v) })} />
        </Row>
      </Group>
      <button type="button" className="btn" onClick={test}>
        <Icon name="speaker" />
        {tr("Ouvir exemplo")}</button>
    </>
  );
}

// ------------------------------------------------------------------ Recursos

function Capabilities() {
  useLanguage();
  const s = useApp((st) => st.settings);
  return (
    <>
      <h3>{tr("Recursos")}</h3>
      <p className="lead">{tr("Ferramentas oferecidas aos modelos. Modelos que não suportam ferramentas simplesmente não as usam.")}</p>
      <Group title={tr("Arquivos e código")}>
        <Row title={tr("Execução de código")} desc={tr("Permite rodar Python e Bash numa distro WSL2 isolada (ceu-sandbox) para analisar dados e gerar arquivos (.docx, .xlsx, .pdf, imagens).")}>
          <Switch on={s.tool_code} onChange={(v) => save({ tool_code: v })} />
        </Row>
        <Row title={tr("Arquivos da conversa")} desc={tr("Permite ler, criar e listar arquivos na pasta própria de cada conversa.")}>
          <Switch on={s.tool_files} onChange={(v) => save({ tool_files: v })} />
        </Row>
        <Row
          title={tr("Acesso à rede no sandbox")}
          desc={tr("Instalar pacotes e acessar a internet de dentro da execução de código. Hoje o sandbox sempre tem rede; esta opção passará a bloqueá-la.")}
          badge={tr("em breve")}
        >
          <Switch on={true} disabled onChange={() => {}} />
        </Row>
      </Group>
    </>
  );
}

function ModelsList({ models, empty }: { models: Provider["models"]; empty: string }) {
  useLanguage();
  if (!models.length) return <div className="prov-models">{empty}</div>;
  return (
    <div className="prov-models">
      {models.length} {tr("modelo")}{models.length === 1 ? "" : "s"}:{" "}
      {models.slice(0, 40).map((m) => (
        <code key={m.id}>{m.id}</code>
      ))}
      {models.length > 40 && tr("e mais {0}", models.length - 40)}
    </div>
  );
}

function ProvHead({ p, open, toggle, detail }: { p: Provider; open: boolean; toggle: () => void; detail: string }) {
  useLanguage();
  const status = !p.enabled ? "" : p.models.length ? "ok" : "err";
  return (
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
      <span className={"dot " + status} />
      <span className="n">{p.name}</span>
      <span className="d">{detail}</span>
      <Ic name="chevron-right" className="chev" />
    </div>
  );
}

const plural = (n: number) => tr("{0} modelo{1}", n, n === 1 ? "" : "s");

function RemoveBtn({ p, body }: { p: Provider; body: string }) {
  useLanguage();
  return (
    <button
      type="button"
      className="btn danger"
      onClick={async () => {
        const ok = await confirmDialog({ title: tr("Remover {0}?", p.name), body, confirm: tr("Remover"), danger: true });
        if (!ok) return;
        try {
          await api.deleteProvider(p.id);
        } catch (e: any) {
          toast(e.message);
        }
        await providersChanged();
      }}
    >
      <Icon name="trash" />
      {tr("Remover")}</button>
  );
}

function ProviderCard({ p, initiallyOpen }: { p: Provider; initiallyOpen: boolean }) {
  useLanguage();
  const [open, setOpen] = useState(initiallyOpen);
  const [err, setErrState] = useState(lastErrors.get(p.id) || "");
  const [models, setModels] = useState(p.models);
  const [refreshing, setRefreshing] = useState(false);
  const [custom, setCustom] = useState("");
  useEffect(() => setModels(p.models), [p.models]);
  const setErr = (msg?: string | null) => {
    setErrState(msg || "");
    if (msg) lastErrors.set(p.id, msg);
    else lastErrors.delete(p.id);
  };

  const apply = async (patch: Record<string, unknown>, label?: string) => {
    setErr("");
    try {
      const res = await api.updateProvider(p.id, patch);
      setErr(res.error);
      await providersChanged();
      if (label && !res.error) toast(label);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const example = p.kind === "anthropic" ? "claude-opus-5" : p.preset === "openrouter" ? "anthropic/claude-opus-5" : p.preset === "local" ? tr("nome-do-modelo") : "gpt-4.1-mini";

  return (
    <div className={cx("prov", open && "is-open")}>
      <ProvHead p={p} open={open} toggle={() => setOpen((o) => !o)} detail={`${p.enabled ? plural(p.models.length) : tr("Desativado")} · ${p.base_url}`} />
      <div className="prov-body">
        <label>{tr("Nome")}</label>
        <input className="input" defaultValue={p.name} onBlur={(e) => e.target.value.trim() !== p.name && apply({ name: e.target.value.trim() || p.name })} />
        <label>{tr("URL base")}</label>
        <input className="input" defaultValue={p.base_url} spellCheck={false} onBlur={(e) => e.target.value.trim() !== p.base_url && apply({ base_url: e.target.value.trim() })} />
        <label>{tr("Chave de API")}</label>
        <input
          className="input"
          type="password"
          placeholder={p.has_key ? tr("Chave salva {0}", p.key_hint || "") : p.preset === "local" ? tr("Opcional") : tr("Cole sua chave de API")}
          autoComplete="off"
          spellCheck={false}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v) {
              e.target.value = "";
              apply({ api_key: v }, tr("Chave salva"));
            }
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <ModelsList models={models} empty={tr("Nenhum modelo carregado.")} />
        <label>{tr("Adicionar modelo manualmente")}</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            placeholder={tr("ID do modelo, ex.: {0}", example)}
            spellCheck={false}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom.trim()) {
                e.preventDefault();
                apply({ add_model: custom.trim() }, tr("Modelo adicionado")).then(() => setCustom(""));
              }
            }}
          />
          <button type="button" className="btn" onClick={() => custom.trim() && apply({ add_model: custom.trim() }, tr("Modelo adicionado")).then(() => setCustom(""))}>
            {tr("Adicionar")}</button>
        </div>
        {err && <div className="prov-error">{err}</div>}
        <div className="actions-row">
          <button
            type="button"
            className="btn"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              setErr("");
              try {
                const res = await api.refreshProvider(p.id);
                setErr(res.error);
                setModels(res.provider.models);
                await providersChanged();
              } catch (e: any) {
                setErr(e.message);
              }
              setRefreshing(false);
            }}
          >
            <Icon name="retry" />
            {tr("Atualizar modelos")}</button>
          <div className="grow" />
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{tr("Ativo")}</span>
          <Switch on={p.enabled} onChange={(v) => apply({ enabled: v })} />
          <RemoveBtn p={p} body={tr("A chave e a lista de modelos serão apagadas. Conversas existentes continuam salvas.")} />
        </div>
      </div>
    </div>
  );
}

/** The ChatGPT provider and the Codex runtimes share one Codex account: the login lives in the
 * runtimes hub (server/integrations.py) and this only reflects it. */
function CodexLogin() {
  useLanguage();
  const integ = useApp((s) => s.integrations.find((i) => i.id === "codex_sdk"));
  useEffect(() => {
    loadIntegrations();
  }, []);
  if (!integ) return null;
  const connected = integ.state === "connected";
  return (
    <div className="codex-login">
      <div className="prov-error" style={{ color: integ.state === "error" ? "var(--danger)" : connected ? "var(--ink)" : "var(--ink-2)" }}>
        {connected ? tr("Conectado: {0}.", integ.detail) : integ.detail}
      </div>
      <button type="button" className={cx("btn", !connected && "primary")} onClick={() => openSettings("runtimes", "codex_sdk")}>
        {connected ? tr("Gerenciar conta") : integ.installed ? tr("Entrar com ChatGPT") : tr("Configurar o Codex")}
      </button>
    </div>
  );
}

function CodexCard({ p, initiallyOpen }: { p: Provider; initiallyOpen: boolean }) {
  useLanguage();
  const [open, setOpen] = useState(initiallyOpen);
  const [models, setModels] = useState(p.models);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => setModels(p.models), [p.models]);
  return (
    <div className={cx("prov", open && "is-open")}>
      <ProvHead p={p} open={open} toggle={() => setOpen((o) => !o)} detail={p.enabled ? tr("{0} · login com ChatGPT", plural(p.models.length)) : tr("Desativado")} />
      <div className="prov-body">
        <p className="lead" style={{ margin: "0 0 4px" }}>
          {tr("Usa o app-server do Codex CLI para autenticar com sua conta ChatGPT (Plus/Pro/Team). O login é o mesmo dos runtimes Codex SDK e Codex CLI, e o CEU nunca vê seus tokens: só abre o navegador e pergunta ao Codex se deu certo.")}</p>
        <CodexLogin />
        <ModelsList models={models} empty={tr("Nenhum modelo carregado ainda — entre com sua conta ChatGPT.")} />
        <div className="actions-row">
          <button
            type="button"
            className="btn"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                const res = await api.refreshProvider(p.id);
                setModels(res.provider.models);
                await providersChanged();
              } catch (e: any) {
                toast(e.message);
              }
              setRefreshing(false);
            }}
          >
            <Icon name="retry" />
            {tr("Atualizar modelos")}</button>
          <div className="grow" />
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{tr("Ativo")}</span>
          <Switch
            on={p.enabled}
            onChange={async (v) => {
              await api.updateProvider(p.id, { enabled: v }).catch((e) => toast(e.message));
              await providersChanged();
            }}
          />
          <RemoveBtn p={p} body={tr("Isso só desconecta o CEU — sua sessão do Codex CLI continua logada. Conversas existentes continuam salvas.")} />
        </div>
      </div>
    </div>
  );
}

const PRESETS = (): [string, string, string][] => ([
  ["anthropic", "Anthropic", "Claude — Opus, Sonnet, Haiku"],
  ["openai", "OpenAI", tr("Modelos GPT pela API da OpenAI")],
  ["codex", "ChatGPT (Codex)", tr("Login com sua conta ChatGPT — sem chave de API")],
  ["openrouter", "OpenRouter", tr("Centenas de modelos com uma chave")],
  ["local", "Local", "llama.cpp, Ollama, LM Studio"],
  ["custom", tr("Outro"), tr("Qualquer API compatível com OpenAI")],
]);

function AddProviderForm({ preset, label, onDone, onCancel }: { preset: string; label: string; onDone: (id: string) => void; onCancel: () => void }) {
  useLanguage();
  const presets = useApp((s) => s.presets);
  const [base, setBase] = useState(presets[preset]?.base_url || "");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      const res = await api.createProvider({
        preset,
        name: preset === "local" || preset === "custom" ? undefined : label,
        base_url: base.trim(),
        api_key: key.trim(),
      });
      await providersChanged();
      if (res.error) {
        lastErrors.set(res.provider.id, res.error);
        toast(tr("{0} adicionado, mas não conectou.", label), { duration: 5000 });
      } else toast(tr("{0} conectado — {1} modelos", label, res.provider.models.length));
      onDone(res.provider.id);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="prov" style={{ padding: "4px 14px 14px" }}>
      <div className="prov-body" style={{ display: "block", borderTop: 0, padding: 0 }}>
        <label>{tr("URL base — ")}{label}</label>
        <input className="input" value={base} placeholder="https://…/v1" spellCheck={false} onChange={(e) => setBase(e.target.value)} />
        <label>{tr("Chave de API")}</label>
        <input
          className="input"
          type="password"
          placeholder={preset === "local" ? tr("Opcional") : tr("Chave de API")}
          autoComplete="off"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        {err && <div className="prov-error">{err}</div>}
        <div className="actions-row">
          <button type="button" className="btn primary" disabled={busy} onClick={go}>
            {tr("Conectar")}</button>
          <button type="button" className="btn ghost" onClick={onCancel}>
            {tr("Cancelar")}</button>
        </div>
      </div>
    </div>
  );
}

function Providers({ openId, setOpenId }: { openId: string | null; setOpenId: (id: string | null) => void }) {
  useLanguage();
  const providers = useApp((s) => s.providers);
  const [form, setForm] = useState<[string, string] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h3>{tr("Provedores")}</h3>
      <p className="lead">
        {tr("Conecte as APIs que você usa. As chaves ficam somente neste computador, no banco local do CEU, e nunca são enviadas ao navegador.")}</p>
      {providers.length ? (
        providers.map((p) =>
          p.preset === "codex" ? (
            <CodexCard key={p.id + (openId === p.id ? ":o" : "")} p={p} initiallyOpen={openId === p.id} />
          ) : (
            <ProviderCard key={p.id + (openId === p.id ? ":o" : "")} p={p} initiallyOpen={openId === p.id} />
          ),
        )
      ) : (
        <p className="lead">{tr("Nenhum provedor conectado ainda.")}</p>
      )}
      <div>
        <p className="lead" style={{ margin: "18px 0 10px" }}>
          {tr("Adicionar provedor")}</p>
        <div className="preset-grid">
          {PRESETS().map(([id, name, desc]) => (
            <button
              key={id}
              type="button"
              className="preset"
              disabled={busy && id === "codex"}
              onClick={async () => {
                if (id !== "codex") return setForm([id, name]);
                const existing = providers.find((p) => p.preset === "codex");
                if (existing) return setOpenId(existing.id);
                setBusy(true);
                try {
                  const res = await api.createProvider({ preset: "codex" });
                  await providersChanged();
                  setOpenId(res.provider.id);
                } catch (e: any) {
                  toast(e.message);
                }
                setBusy(false);
              }}
            >
              <b>{name}</b>
              <span>{desc}</span>
            </button>
          ))}
        </div>
        {form && (
          <AddProviderForm
            key={form[0]}
            preset={form[0]}
            label={form[1]}
            onCancel={() => setForm(null)}
            onDone={(id) => {
              setForm(null);
              setOpenId(id);
            }}
          />
        )}
      </div>
    </>
  );
}

function Shortcuts() {
  useLanguage();
  return (
    <>
      <h3>{tr("Teclado")}</h3>
      <p className="lead">{tr("Tudo no CEU pode ser feito pelo teclado.")}</p>
      <div className="shortcut-list">
        {SHORTCUTS().map(([label, keys]) => [
          <div key={label}>{label}</div>,
          <div key={label + "k"} className="k">
            {keys.split(" / ").map((k) => (
              <kbd key={k}>{kbd(k)}</kbd>
            ))}
          </div>,
        ])}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Uso

const num = (n: number) => n.toLocaleString(getLocale());
const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) + tr(" mi") : n >= 1e4 ? Math.round(n / 1e3) + tr(" mil") : num(n));

function Usage() {
  useLanguage();
  const [u, setU] = useState<UsageReport | null>(null);
  useEffect(() => {
    api.usage().then(setU).catch((e) => toast(e.message));
  }, []);
  if (!u)
    return (
      <>
        <h3>{tr("Uso")}</h3>
        <p className="lead">{tr("Carregando…")}</p>
      </>
    );
  const t = u.totals;
  // last 30 days, including days without activity
  const byDay = new Map(u.by_day.map((d) => [d.day, d]));
  const days = Array.from({ length: u.days }, (_, i) => {
    const d = new Date(Date.now() - (u.days - 1 - i) * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { key, date: d, output: byDay.get(key)?.output || 0, responses: byDay.get(key)?.responses || 0 };
  });
  const peak = Math.max(1, ...days.map((d) => d.output));
  const topModel = Math.max(1, ...u.by_model.map((m) => m.output));
  return (
    <>
      <h3>{tr("Uso")}</h3>
      <p className="lead">{tr("Calculado a partir das suas conversas neste computador. Tokens são os informados por cada provedor; modelos locais podem não informar.")}</p>
      <div className="stat-tiles">
        <div>
          <b>{num(t.conversations)}</b>
          <span>{tr("conversas")}</span>
        </div>
        <div>
          <b>{num(t.prompts)}</b>
          <span>{tr("mensagens enviadas")}</span>
        </div>
        <div>
          <b>{compact(t.input_tokens)}</b>
          <span>{tr("tokens de entrada")}</span>
        </div>
        <div>
          <b>{compact(t.output_tokens)}</b>
          <span>{tr("tokens de saída")}</span>
        </div>
      </div>
      <Group title={tr("Tokens de saída por dia — últimos 30 dias")}>
        <div className="day-bars" role="img" aria-label={tr("Tokens de saída por dia nos últimos 30 dias")}>
          {days.map((d) => (
            <i
              key={d.key}
              style={{ height: d.output ? Math.max(3, (d.output / peak) * 100) + "%" : 0 }}
              data-tip={tr("{0} · {1} tokens · {2} resposta{3}", d.date.toLocaleDateString(getLocale(), { day: "numeric", month: "short" }), num(d.output), d.responses, d.responses === 1 ? "" : "s")}
            />
          ))}
        </div>
        <div className="day-axis">
          <span>{days[0].date.toLocaleDateString(getLocale(), { day: "numeric", month: "short" })}</span>
          <span>{tr("hoje")}</span>
        </div>
      </Group>
      <Group title={tr("Por modelo")}>
        {!u.by_model.length ? (
          <p className="empty-note">{tr("Nenhuma resposta com contagem de tokens ainda.")}</p>
        ) : (
          <div className="model-usage">
            {u.by_model.map((m) => (
              <div key={m.model} className="mu-row">
                <span className="n" title={m.model}>
                  {m.model}
                </span>
                <span className="bar">
                  <i style={{ width: (m.output / topModel) * 100 + "%" }} />
                </span>
                <span className="v">
                  {compact(m.output)} <small>· {num(m.responses)} {tr("resp.")}</small>
                </span>
              </div>
            ))}
          </div>
        )}
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Dados

function ArchivedList({ onChange }: { onChange: () => void }) {
  useLanguage();
  const [list, setList] = useState<import("../api").Conversation[] | null>(null);
  const load = () => api.conversations(true).then(setList).catch((e) => toast(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!list) return <p className="empty-note">{tr("Carregando…")}</p>;
  if (!list.length) return <p className="empty-note">{tr("Nenhuma conversa arquivada.")}</p>;
  return (
    <ul className="archived">
      {list.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            className="t"
            onClick={() => {
              closeDialog(useUi.getState().dialogs.find((d) => d.kind === "settings")!.id);
              openConversation(c.id);
            }}
          >
            {c.title || tr("Nova conversa")}
          </button>
          <span className="when">{relTime(c.updated_at)}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={tr("Restaurar")}
            data-tip={tr("Restaurar")}
            onClick={async () => {
              await setArchived(c, false);
              load();
              onChange();
            }}
          >
            <Icon name="unarchive" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={tr("Excluir")}
            data-tip={tr("Excluir")}
            onClick={async () => {
              if (!(await confirmDialog({ title: tr("Excluir conversa arquivada?"), body: tr("“{0}” será excluída.", c.title || tr("Nova conversa")), confirm: tr("Excluir"), danger: true }))) return;
              await api.deleteConversation(c.id).catch((e) => toast(e.message));
              load();
              onChange();
            }}
          >
            <Icon name="trash" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Data() {
  useLanguage();
  const count = useApp((s) => s.convs.length);
  const [st, setSt] = useState<StorageReport | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const load = () => api.storage().then(setSt).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <h3>{tr("Dados")}</h3>
      <p className="lead">{tr("Conversas, anexos e configurações ficam em data/app.db, na pasta do CEU. Nada sai deste computador além das mensagens enviadas aos provedores.")}</p>
      <Group title={tr("Armazenamento")}>
        {st ? (
          <div className="storage">
            <div>
              <span>{tr("Banco de dados")}</span>
              <b>{formatSize(st.database)}</b>
            </div>
            <div>
              <span>{tr("Anexos enviados")}</span>
              <b>
                {formatSize(st.attachments.bytes)} <small>· {num(st.attachments.count)}</small>
              </b>
            </div>
            <div>
              <span>{tr("Arquivos das conversas")}</span>
              <b>
                {formatSize(st.workspaces.bytes)} <small>· {num(st.workspaces.count)}</small>
              </b>
            </div>
          </div>
        ) : (
          <p className="empty-note">{tr("Calculando…")}</p>
        )}
      </Group>
      <Group title={tr("Conversas")}>
        <Row title={tr("Conversas arquivadas")} desc={tr("Saem da barra lateral, mas continuam na busca e podem ser restauradas.")}>
          <button type="button" className="btn" onClick={() => setShowArchived((x) => !x)}>
            {showArchived ? tr("Ocultar") : tr("Gerenciar{0}", st?.archived ? ` (${st.archived})` : "")}
          </button>
        </Row>
        {showArchived && <ArchivedList onChange={load} />}
        <Row title={tr("Arquivar todas as conversas")} desc={tr("Move todo o histórico para as arquivadas.")}>
          <button
            type="button"
            className="btn"
            disabled={!count}
            onClick={async () => {
              if (!(await confirmDialog({ title: tr("Arquivar todas as conversas?"), body: tr("{0} conversa{1} sairão da barra lateral.", count, count === 1 ? "" : "s"), confirm: tr("Arquivar tudo") }))) return;
              await api.archiveAll().catch((e) => toast(e.message));
              newChat();
              await refreshConvs();
              load();
              toast(tr("Conversas arquivadas"));
            }}
          >
            <Icon name="archive" />
            {tr("Arquivar tudo")}</button>
        </Row>
        <Row title={tr("Exportar dados")} desc={tr("Todas as conversas (com versões e ramificações), memórias e configurações em um arquivo JSON. Chaves de API não são incluídas.")}>
          <button type="button" className="btn" onClick={() => download("/api/export", "ceu-export.json").catch((e) => toast(e.message))}>
            <Icon name="download" />
            {tr("Exportar")}</button>
        </Row>
        <Row title={tr("Excluir todas as conversas")} desc={tr("Remove permanentemente o histórico, inclusive as arquivadas, e os anexos.")}>
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              const ok = await confirmDialog({
                title: tr("Excluir todas as conversas?"),
                body: tr("Isso apaga {0} conversa{1}{2}, com todos os anexos. Não é possível desfazer.", count, count === 1 ? "" : "s", st?.archived ? tr(" e {0} arquivada{1}", st.archived, st.archived === 1 ? "" : "s") : ""),
                confirm: tr("Excluir tudo"),
                danger: true,
              });
              if (!ok) return;
              try {
                await api.deleteAll();
              } catch (e: any) {
                return toast(e.message);
              }
              allDeleted();
              load();
              toast(tr("Todas as conversas foram excluídas"));
            }}
          >
            <Icon name="trash" />
            {tr("Excluir tudo")}</button>
        </Row>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ dialog

function norm(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function SettingsDialog({ id, section: rawSection, focus }: { id: number; section: string; focus?: string }) {
  const language = useLanguage();
  const section = ALIASES[rawSection] || rawSection;
  const [openId, setOpenId] = useState<string | null>(null);
  const [savedOn, setSavedOn] = useState(false);
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const setSection = (s: string) => useUi.setState((st) => ({ dialogs: st.dialogs.map((d) => (d.id === id ? { ...d, section: s } : d)) }));

  const visible = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return SECTIONS();
    return SECTIONS().filter((s) => norm(s.label + " " + s.keywords).includes(q));
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- Section labels and search keywords follow the locale.
  }, [query, language]);

  useEffect(() => {
    if (visible.length && !visible.some((s) => s.id === section)) setSection(visible[0].id);
  }, [visible]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    flashSaved = () => {
      setSavedOn(true);
      clearTimeout(t);
      t = setTimeout(() => setSavedOn(false), 1200);
    };
    return () => {
      clearTimeout(t);
      flashSaved = () => {};
    };
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0);
  }, [section]);

  const groups = [...new Set(visible.map((s) => s.group))];

  return (
    <DialogShell id={id} className="settings" label={tr("Configurações")}>
      <nav className="settings-nav">
        <h2>{tr("Configurações")}</h2>
        <label className="settings-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder={tr("Buscar")}
            aria-label={tr("Buscar nas configurações")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </label>
        {groups.map((g) => (
          <div key={g} className="settings-nav-group">
            <span className="settings-nav-h">{g}</span>
            {visible
              .filter((s) => s.group === g)
              .map((s) => (
                <button key={s.id} type="button" className={section === s.id ? "is-on" : ""} aria-current={section === s.id ? "page" : undefined} onClick={() => setSection(s.id)}>
                  <Icon name={s.icon} />
                  {s.label}
                </button>
              ))}
          </div>
        ))}
        {!visible.length && <p className="settings-nav-empty">{tr("Nada encontrado.")}</p>}
      </nav>
      <div className="settings-body" ref={bodyRef}>
        <button type="button" className="icon-btn settings-close" aria-label={tr("Fechar")} onClick={() => closeDialog(id)}>
          <Icon name="close" />
        </button>
        <span className={cx("saved", savedOn && "is-on")}>{tr("Salvo")}</span>
        {section === "general" && <General />}
        {section === "appearance" && <Appearance />}
        {section === "personalization" && <Personalization />}
        {section === "memory" && <MemorySection />}
        {section === "notifications" && <Notifications />}
        {section === "voice" && <Voice />}
        {section === "providers" && <Providers openId={openId} setOpenId={setOpenId} />}
        {section === "runtimes" && <RuntimesHub focus={focus} />}
        {section === "github" && <GitHubSettings />}
        {section === "capabilities" && <Capabilities />}
        {section === "usage" && <Usage />}
        {section === "shortcuts" && <Shortcuts />}
        {section === "data" && <Data />}
      </div>
    </DialogShell>
  );
}
