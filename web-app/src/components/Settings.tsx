// Settings dialog. Structure follows claude.ai and chatgpt.com settings (see docs/referencias-claude-chatgpt.md):
// a searchable navigation in groups, one section per area, changes saved as they happen.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Level, type Memory, type Provider, type Settings as SettingsT, type StorageReport, type UsageReport } from "../api";
import { Ic, Icon } from "../lib/icons";
import { cx, debounce, download, formatSize, kbd, relTime } from "../lib/util";
import { ACCENTS, allDeleted, applySettings, loadIntegrations, newChat, openConversation, providersChanged, refreshConvs, requestNotifications, setArchived } from "../state/actions";
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

const SECTIONS: Section[] = [
  { id: "general", label: "Geral", icon: "sliders", group: "Pessoais", keywords: "idioma língua envio enter modelo padrão títulos temporária" },
  { id: "appearance", label: "Aparência", icon: "palette", group: "Pessoais", keywords: "tema escuro claro modo destaque cor acento fonte serif mono tamanho texto código largura movimento animação espaço partículas" },
  { id: "personalization", label: "Personalização", icon: "user", group: "Pessoais", keywords: "instruções personalizadas apelido nome ocupação sobre você estilo tom cordialidade entusiasmo títulos listas emoji personalidade" },
  { id: "memory", label: "Memória", icon: "memory", group: "Pessoais", keywords: "memórias lembrar contexto histórico" },
  { id: "notifications", label: "Notificações", icon: "bell", group: "Pessoais", keywords: "notificação aviso som conclusão resposta" },
  { id: "voice", label: "Voz", icon: "voice", group: "Pessoais", keywords: "voz leitura ler em voz alta velocidade fala" },
  { id: "providers", label: "Provedores", icon: "plug", group: "Modelos", keywords: "api chave anthropic openai chatgpt codex openrouter local ollama llama lm studio modelos" },
  { id: "runtimes", label: "Runtimes e agentes", icon: "cube", group: "Modelos", keywords: "code runtime sdk codex claude antigravity agy cli redir agente externo login conectar instalar autenticação conta" },
  { id: "github", label: "GitHub", icon: "plug", group: "Modelos", keywords: "git github token autenticação conectar desconectar repositório publicação release push" },
  { id: "capabilities", label: "Recursos", icon: "tools", group: "Modelos", keywords: "ferramentas execução código python bash sandbox arquivos rede wsl" },
  { id: "usage", label: "Uso", icon: "gauge", group: "Sistema", keywords: "tokens estatísticas consumo mensagens por modelo" },
  { id: "shortcuts", label: "Teclado", icon: "keyboard", group: "Sistema", keywords: "atalhos teclado tecla" },
  { id: "data", label: "Dados", icon: "database", group: "Sistema", keywords: "exportar arquivar arquivadas excluir apagar armazenamento backup json" },
];

/** Old section ids still used by callers. */
const ALIASES: Record<string, string> = { instructions: "personalization" };

export const SHORTCUTS: [string, string][] = [
  ["Nova conversa (ou sessão, no Code)", "Ctrl ⇧ O"],
  ["Ir para Chat / Code", "Ctrl ⇧ 1 / Ctrl ⇧ 2"],
  ["Buscar e comandos", "Ctrl K"],
  ["Trocar modelo", "Ctrl ."],
  ["Alternar barra lateral", "Ctrl B"],
  ["Conversa anterior / seguinte", "Alt ↑ / Alt ↓"],
  ["Focar o campo de mensagem", "⇧ Esc"],
  ["Editar a última mensagem", "↑ (campo vazio)"],
  ["Interromper a resposta", "Esc"],
  ["Copiar a última resposta", "Ctrl ⇧ C"],
  ["Renomear a conversa", "F2"],
  ["Excluir a conversa", "Ctrl ⇧ ⌫"],
  ["Menu da conversa: fixar, renomear, exportar, arquivar, excluir", "P / R / E / A / D"],
  ["Configurações", "Ctrl ,"],
  ["Atalhos de teclado", "Ctrl /"],
];

/** provider id → last connection error, shown inside its card (survives re-renders) */
const lastErrors = new Map<string, string>();

let flashSaved = () => {};

async function save(patch: Partial<SettingsT>) {
  // optimistic: the UI reflects the change immediately, the server confirms
  setS((st) => ({ settings: { ...st.settings, ...patch } }));
  applySettings();
  try {
    setS({ settings: await api.settings(patch) });
    applySettings();
    flashSaved();
  } catch (e: any) {
    toast(e.message);
  }
}


// ------------------------------------------------------------------ controls

function Seg<T extends string | number>({ options, value, onChange, label }: { options: [T, string][]; value: T; onChange: (v: T) => void; label?: string }) {
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
  return (
    <section className="field-group">
      {title && <h4>{title}</h4>}
      <div className="card">{children}</div>
    </section>
  );
}

/** Dropdown with a description per option (ChatGPT's "Estilo e tom" pattern), built on the app menu. */
function MenuSelect<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string; sub?: string }[]; onChange: (v: T) => void; label: string }) {
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
  const providers = useApp((s) => s.providers);
  const models = allModels(providers);
  return (
    <select className="select" value={value || ""} onChange={(e) => onChange(e.target.value || null)}>
      {allowSame && <option value="">{allowSame === true ? "O mesmo da conversa" : allowSame}</option>}
      {!allowSame && !models.length && <option value="">Nenhum modelo</option>}
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
  return (
    <div className="stepper">
      <button type="button" aria-label="Diminuir" disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span>
        {value}
        {unit && <small>{unit}</small>}
      </span>
      <button type="button" aria-label="Aumentar" disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

/** Text setting saved as the user types (debounced), like both references. */
function TextSetting({ k, rows, placeholder, max }: { k: "instructions" | "nickname" | "occupation" | "about"; rows?: number; placeholder?: string; max?: number }) {
  const initial = useApp.getState().settings[k];
  const persist = useMemo(() => debounce((v: string) => save({ [k]: v }), 500), [k]);
  if (!rows)
    return <input className="input wide" defaultValue={initial} placeholder={placeholder} maxLength={max} onChange={(e) => persist(e.target.value)} />;
  return <textarea className="textarea" rows={rows} defaultValue={initial} placeholder={placeholder} maxLength={max} onChange={(e) => persist(e.target.value)} />;
}

// ------------------------------------------------------------------ Geral

function General() {
  const s = useApp((st) => st.settings);
  return (
    <>
      <h3>Geral</h3>
      <p className="lead">Comportamento do aplicativo. As alterações são salvas automaticamente.</p>
      <Group>
        <Row title="Idioma" desc="Idioma da interface. Por enquanto o CEU só está disponível em português." badge="em breve">
          <select className="select" value={s.language} onChange={(e) => save({ language: e.target.value as SettingsT["language"] })}>
            <option value="auto">Detecção automática</option>
            <option value="pt-BR">Português (Brasil)</option>
            <option value="en">English</option>
          </select>
        </Row>
        <Row title="Envio" desc="Com Ctrl+Enter, Enter sempre insere uma nova linha.">
          <select className="select" value={s.send_key} onChange={(e) => save({ send_key: e.target.value as SettingsT["send_key"] })}>
            <option value="enter">Enter envia</option>
            <option value="ctrl-enter">{kbd("Ctrl")}+Enter envia</option>
          </select>
        </Row>
      </Group>
      <Group title="Conversas">
        <Row title="Modelo padrão" desc="Usado em conversas novas.">
          <ModelSelect value={s.default_model} onChange={(v) => save({ default_model: v })} />
        </Row>
        <Row title="Modelo para títulos" desc="Gera o título de cada conversa depois da primeira resposta.">
          <ModelSelect value={s.title_model} allowSame onChange={(v) => save({ title_model: v })} />
        </Row>
        <Row title="Modelo para sugestões" desc="Escreve os três cards de início: os de cada agente, a partir do propósito dele, e os da conversa nova, a partir do seu histórico. Um modelo rápido e barato basta.">
          <ModelSelect value={s.suggestion_model} allowSame="O do agente / o padrão" onChange={(v) => save({ suggestion_model: v })} />
        </Row>
        <Row title="Começar em conversa temporária" desc="Novas conversas não entram no histórico e são apagadas quando você sai delas. Dá para alternar no ícone do topo.">
          <Switch on={s.temporary_default} onChange={(v) => save({ temporary_default: v })} />
        </Row>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Aparência

function ModeCard({ mode, label, on, onClick }: { mode: "system" | "light" | "dark"; label: string; on: boolean; onClick: () => void }) {
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
  const s = useApp((st) => st.settings);
  return (
    <>
      <h3>Aparência</h3>
      <p className="lead">Cores, tipografia e movimento. Aplicados na hora.</p>
      <Group title="Estilo visual">
        <div className="mode-cards" role="radiogroup" aria-label="Modo">
          <ModeCard mode="system" label="Sistema" on={s.theme === "system"} onClick={() => save({ theme: "system" })} />
          <ModeCard mode="light" label="Claro" on={s.theme === "light"} onClick={() => save({ theme: "light" })} />
          <ModeCard mode="dark" label="Escuro" on={s.theme === "dark"} onClick={() => save({ theme: "dark" })} />
        </div>
        <Row title="Destaque" desc="Cor de links, seleção e indicadores.">
          <div className="swatches" role="radiogroup" aria-label="Destaque">
            {Object.entries(ACCENTS).map(([id, a]) => (
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
      <Group title="Texto">
        <Row title="Fonte da conversa" desc="Aplica-se às mensagens.">
          <Seg label="Fonte da conversa" options={[["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["system", "Sistema"]]} value={s.chat_font} onChange={(v) => save({ chat_font: v })} />
        </Row>
        <Row title="Tamanho do texto" desc="Mensagens e campo de texto.">
          <Seg label="Tamanho do texto" options={[[14, "P"], [15, "M"], [16, "G"], [17, "GG"]]} value={s.font_size} onChange={(v) => save({ font_size: Number(v) })} />
        </Row>
        <Row title="Tamanho do código" desc="Blocos de código nas respostas.">
          <Stepper value={s.code_font_size} min={11} max={18} unit="px" onChange={(v) => save({ code_font_size: v })} />
        </Row>
        <Row title="Largura da conversa" desc="Largura máxima das mensagens e do campo de texto.">
          <Seg label="Largura da conversa" options={[["narrow", "Estreita"], ["medium", "Média"], ["wide", "Larga"]]} value={s.width} onChange={(v) => save({ width: v })} />
        </Row>
      </Group>
      <Group title="Movimento">
        <Row title="Animações" desc="“Sistema” segue a preferência de movimento reduzido do Windows.">
          <Seg label="Animações" options={[["system", "Sistema"], ["reduce", "Reduzidas"], ["full", "Completas"]]} value={s.motion} onChange={(v) => save({ motion: v })} />
        </Row>
        <Row title="Espaço animado" desc="Partículas ao fundo que aceleram enquanto um modelo responde.">
          <Switch on={s.ambient !== false} onChange={(v) => save({ ambient: v })} />
        </Row>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Personalização

const STYLE_OPTIONS: { v: SettingsT["style"]; label: string; sub: string }[] = [
  { v: "default", label: "Padrão", sub: "Estilo e tom de cada modelo" },
  { v: "professional", label: "Profissional", sub: "Preciso e refinado" },
  { v: "friendly", label: "Amigável", sub: "Acolhedor e conversador" },
  { v: "candid", label: "Franco", sub: "Direto e encorajador" },
  { v: "quirky", label: "Criativo", sub: "Divertido e inventivo" },
  { v: "efficient", label: "Eficiente", sub: "Conciso e simples" },
  { v: "cynical", label: "Cético", sub: "Crítico e sarcástico" },
];

const LEVELS: { v: Level; label: string }[] = [
  { v: "more", label: "Mais" },
  { v: "default", label: "Padrão" },
  { v: "less", label: "Menos" },
];

function Personalization() {
  const s = useApp((st) => st.settings);
  const trait = (k: "warmth" | "enthusiasm" | "headers_lists" | "emoji", title: string) => (
    <Row title={title}>
      <MenuSelect label={title} value={s[k]} options={LEVELS} onChange={(v) => save({ [k]: v })} />
    </Row>
  );
  return (
    <>
      <h3>Personalização</h3>
      <p className="lead">Tudo aqui vira instrução de sistema, enviada a qualquer modelo a partir da próxima mensagem. Não muda o que os modelos conseguem fazer.</p>
      <Group title="Estilo das respostas">
        <Row title="Estilo e tom" desc="Personalidade básica das respostas.">
          <MenuSelect label="Estilo e tom" value={s.style} options={STYLE_OPTIONS} onChange={(v) => save({ style: v })} />
        </Row>
        {trait("warmth", "Cordialidade")}
        {trait("enthusiasm", "Entusiasmo")}
        {trait("headers_lists", "Títulos e listas")}
        {trait("emoji", "Emoji")}
      </Group>
      <Group title="Sobre você">
        <label className="set-label">Como o CEU deve te chamar?</label>
        <TextSetting k="nickname" placeholder="Apelido" max={60} />
        <label className="set-label">Ocupação</label>
        <TextSetting k="occupation" placeholder="Ex.: engenheiro de software" max={120} />
        <label className="set-label">Mais sobre você</label>
        <TextSetting k="about" rows={4} placeholder="Interesses, valores ou preferências que valem para qualquer conversa." max={2000} />
      </Group>
      <Group title="Instruções personalizadas">
        <TextSetting k="instructions" rows={8} placeholder="Ex.: Responda em português, de forma direta. Sou desenvolvedor Python; prefira exemplos com tipagem." max={8000} />
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Memória

function MemoryItem({ m, onChange }: { m: Memory; onChange: () => void }) {
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
      <button type="button" className="icon-btn" aria-label="Editar memória" data-tip="Editar" onClick={() => setEditing(true)}>
        <Icon name="edit" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Apagar memória"
        data-tip="Apagar"
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
      <h3>Memória</h3>
      <p className="lead">Fatos que você quer que qualquer modelo leve em conta, em todas as conversas. Ficam só neste computador.</p>
      <Group>
        <Row title="Usar memória" desc="Envia as memórias abaixo junto com as instruções de sistema.">
          <Switch on={s.memory_enabled} onChange={(v) => save({ memory_enabled: v })} />
        </Row>
        <Row title="Consultar conversas anteriores" desc="Permite buscar detalhes relevantes no seu histórico ao responder." badge="em breve">
          <Switch on={s.memory_chat_history} onChange={(v) => save({ memory_chat_history: v })} />
        </Row>
      </Group>
      <Group title={mems ? `Memórias salvas (${mems.length})` : "Memórias salvas"}>
        <div className={cx("memories", !s.memory_enabled && "is-off")}>
          {mems && !mems.length && <p className="empty-note">Nenhuma memória ainda. Escreva algo como “Prefiro exemplos em TypeScript”.</p>}
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
              placeholder="Adicionar memória"
              value={draft}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button type="button" className="btn" disabled={!draft.trim()} onClick={add}>
              Adicionar
            </button>
          </div>
        </div>
      </Group>
      {mems && mems.length > 0 && (
        <Row title="Apagar todas as memórias" desc="Remove permanentemente a lista acima.">
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              if (!(await confirmDialog({ title: "Apagar todas as memórias?", body: `${mems.length} memória(s) serão apagadas.`, confirm: "Apagar", danger: true }))) return;
              await api.deleteAllMemories().catch((e) => toast(e.message));
              load();
            }}
          >
            <Icon name="trash" />
            Apagar todas
          </button>
        </Row>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Notificações

function Notifications() {
  const s = useApp((st) => st.settings);
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  return (
    <>
      <h3>Notificações</h3>
      <p className="lead">Avisos quando uma resposta termina e o CEU está em segundo plano.</p>
      <Group>
        <Row
          title="Conclusão de respostas"
          desc={perm === "denied" ? "O sistema bloqueou as notificações deste aplicativo. Libere nas configurações do Windows." : "Notificação do sistema quando uma resposta longa terminar."}
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
        <Row title="Som ao concluir" desc="Um toque curto, também só com o aplicativo em segundo plano.">
          <Switch on={s.notify_sound} onChange={(v) => save({ notify_sound: v })} />
        </Row>
      </Group>
      {s.notify_done && perm === "granted" && (
        <button type="button" className="btn" onClick={() => new Notification("CEU", { body: "É assim que o aviso de resposta pronta aparece." })}>
          <Icon name="bell" />
          Enviar notificação de teste
        </button>
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
  const s = useApp((st) => st.settings);
  const voices = useVoices();
  const sorted = [...voices].sort((a, b) => Number(b.lang.startsWith("pt")) - Number(a.lang.startsWith("pt")) || a.name.localeCompare(b.name));
  const test = () => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("Olá. É assim que as respostas são lidas em voz alta.");
    const v = voices.find((x) => x.name === S().settings.voice_name);
    if (v) u.voice = v;
    else u.lang = "pt-BR";
    u.rate = S().settings.voice_rate || 1;
    speechSynthesis.speak(u);
  };
  if (!("speechSynthesis" in window))
    return (
      <>
        <h3>Voz</h3>
        <p className="lead">A síntese de voz não está disponível neste sistema.</p>
      </>
    );
  return (
    <>
      <h3>Voz</h3>
      <p className="lead">Usada em “Ler em voz alta”, nas ações de cada resposta. As vozes são as instaladas no Windows.</p>
      <Group>
        <Row title="Voz">
          <select className="select" value={s.voice_name} onChange={(e) => save({ voice_name: e.target.value })}>
            <option value="">Padrão do sistema (português)</option>
            {sorted.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} — {v.lang}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Velocidade">
          <Seg label="Velocidade" options={[[0.8, "Lenta"], [1, "Normal"], [1.25, "Rápida"], [1.5, "Muito rápida"]]} value={s.voice_rate} onChange={(v) => save({ voice_rate: Number(v) })} />
        </Row>
      </Group>
      <button type="button" className="btn" onClick={test}>
        <Icon name="speaker" />
        Ouvir exemplo
      </button>
    </>
  );
}

// ------------------------------------------------------------------ Recursos

function Capabilities() {
  const s = useApp((st) => st.settings);
  return (
    <>
      <h3>Recursos</h3>
      <p className="lead">Ferramentas oferecidas aos modelos. Modelos que não suportam ferramentas simplesmente não as usam.</p>
      <Group title="Arquivos e código">
        <Row title="Execução de código" desc="Permite rodar Python e Bash numa distro WSL2 isolada (ceu-sandbox) para analisar dados e gerar arquivos (.docx, .xlsx, .pdf, imagens).">
          <Switch on={s.tool_code} onChange={(v) => save({ tool_code: v })} />
        </Row>
        <Row title="Arquivos da conversa" desc="Permite ler, criar e listar arquivos na pasta própria de cada conversa.">
          <Switch on={s.tool_files} onChange={(v) => save({ tool_files: v })} />
        </Row>
        <Row
          title="Acesso à rede no sandbox"
          desc="Instalar pacotes e acessar a internet de dentro da execução de código. Hoje o sandbox sempre tem rede; esta opção passará a bloqueá-la."
          badge="em breve"
        >
          <Switch on={s.sandbox_network} disabled={!s.tool_code} onChange={(v) => save({ sandbox_network: v })} />
        </Row>
      </Group>
    </>
  );
}

function ModelsList({ models, empty }: { models: Provider["models"]; empty: string }) {
  if (!models.length) return <div className="prov-models">{empty}</div>;
  return (
    <div className="prov-models">
      {models.length} modelo{models.length === 1 ? "" : "s"}:{" "}
      {models.slice(0, 40).map((m) => (
        <code key={m.id}>{m.id}</code>
      ))}
      {models.length > 40 && `e mais ${models.length - 40}`}
    </div>
  );
}

function ProvHead({ p, open, toggle, detail }: { p: Provider; open: boolean; toggle: () => void; detail: string }) {
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

const plural = (n: number) => `${n} modelo${n === 1 ? "" : "s"}`;

function RemoveBtn({ p, body }: { p: Provider; body: string }) {
  return (
    <button
      type="button"
      className="btn danger"
      onClick={async () => {
        const ok = await confirmDialog({ title: `Remover ${p.name}?`, body, confirm: "Remover", danger: true });
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
      Remover
    </button>
  );
}

function ProviderCard({ p, initiallyOpen }: { p: Provider; initiallyOpen: boolean }) {
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

  const example = p.kind === "anthropic" ? "claude-opus-5" : p.preset === "openrouter" ? "anthropic/claude-opus-5" : p.preset === "local" ? "nome-do-modelo" : "gpt-4.1-mini";

  return (
    <div className={cx("prov", open && "is-open")}>
      <ProvHead p={p} open={open} toggle={() => setOpen((o) => !o)} detail={`${p.enabled ? plural(p.models.length) : "Desativado"} · ${p.base_url}`} />
      <div className="prov-body">
        <label>Nome</label>
        <input className="input" defaultValue={p.name} onBlur={(e) => e.target.value.trim() !== p.name && apply({ name: e.target.value.trim() || p.name })} />
        <label>URL base</label>
        <input className="input" defaultValue={p.base_url} spellCheck={false} onBlur={(e) => e.target.value.trim() !== p.base_url && apply({ base_url: e.target.value.trim() })} />
        <label>Chave de API</label>
        <input
          className="input"
          type="password"
          placeholder={p.has_key ? `Chave salva ${p.key_hint || ""}` : p.preset === "local" ? "Opcional" : "Cole sua chave de API"}
          autoComplete="off"
          spellCheck={false}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v) {
              e.target.value = "";
              apply({ api_key: v }, "Chave salva");
            }
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <ModelsList models={models} empty="Nenhum modelo carregado." />
        <label>Adicionar modelo manualmente</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            placeholder={`ID do modelo, ex.: ${example}`}
            spellCheck={false}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom.trim()) {
                e.preventDefault();
                apply({ add_model: custom.trim() }, "Modelo adicionado").then(() => setCustom(""));
              }
            }}
          />
          <button type="button" className="btn" onClick={() => custom.trim() && apply({ add_model: custom.trim() }, "Modelo adicionado").then(() => setCustom(""))}>
            Adicionar
          </button>
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
            Atualizar modelos
          </button>
          <div className="grow" />
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>Ativo</span>
          <Switch on={p.enabled} onChange={(v) => apply({ enabled: v })} />
          <RemoveBtn p={p} body="A chave e a lista de modelos serão apagadas. Conversas existentes continuam salvas." />
        </div>
      </div>
    </div>
  );
}

/** The ChatGPT provider and the Codex runtimes share one Codex account: the login lives in the
 * runtimes hub (server/integrations.py) and this only reflects it. */
function CodexLogin() {
  const integ = useApp((s) => s.integrations.find((i) => i.id === "codex_sdk"));
  useEffect(() => {
    loadIntegrations();
  }, []);
  if (!integ) return null;
  const connected = integ.state === "connected";
  return (
    <div className="codex-login">
      <div className="prov-error" style={{ color: integ.state === "error" ? "var(--danger)" : connected ? "var(--ink)" : "var(--ink-2)" }}>
        {connected ? `Conectado: ${integ.detail}.` : integ.detail}
      </div>
      <button type="button" className={cx("btn", !connected && "primary")} onClick={() => openSettings("runtimes", "codex_sdk")}>
        {connected ? "Gerenciar conta" : integ.installed ? "Entrar com ChatGPT" : "Configurar o Codex"}
      </button>
    </div>
  );
}

function CodexCard({ p, initiallyOpen }: { p: Provider; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [models, setModels] = useState(p.models);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => setModels(p.models), [p.models]);
  return (
    <div className={cx("prov", open && "is-open")}>
      <ProvHead p={p} open={open} toggle={() => setOpen((o) => !o)} detail={p.enabled ? `${plural(p.models.length)} · login com ChatGPT` : "Desativado"} />
      <div className="prov-body">
        <p className="lead" style={{ margin: "0 0 4px" }}>
          Usa o app-server do Codex CLI para autenticar com sua conta ChatGPT (Plus/Pro/Team). O login é o mesmo dos runtimes Codex SDK e Codex CLI, e o
          CEU nunca vê seus tokens: só abre o navegador e pergunta ao Codex se deu certo.
        </p>
        <CodexLogin />
        <ModelsList models={models} empty="Nenhum modelo carregado ainda — entre com sua conta ChatGPT." />
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
            Atualizar modelos
          </button>
          <div className="grow" />
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>Ativo</span>
          <Switch
            on={p.enabled}
            onChange={async (v) => {
              await api.updateProvider(p.id, { enabled: v }).catch((e) => toast(e.message));
              await providersChanged();
            }}
          />
          <RemoveBtn p={p} body="Isso só desconecta o CEU — sua sessão do Codex CLI continua logada. Conversas existentes continuam salvas." />
        </div>
      </div>
    </div>
  );
}

const PRESETS: [string, string, string][] = [
  ["anthropic", "Anthropic", "Claude — Opus, Sonnet, Haiku"],
  ["openai", "OpenAI", "Modelos GPT pela API da OpenAI"],
  ["codex", "ChatGPT (Codex)", "Login com sua conta ChatGPT — sem chave de API"],
  ["openrouter", "OpenRouter", "Centenas de modelos com uma chave"],
  ["local", "Local", "llama.cpp, Ollama, LM Studio"],
  ["custom", "Outro", "Qualquer API compatível com OpenAI"],
];

function AddProviderForm({ preset, label, onDone, onCancel }: { preset: string; label: string; onDone: (id: string) => void; onCancel: () => void }) {
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
        toast(`${label} adicionado, mas não conectou.`, { duration: 5000 });
      } else toast(`${label} conectado — ${res.provider.models.length} modelos`);
      onDone(res.provider.id);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="prov" style={{ padding: "4px 14px 14px" }}>
      <div className="prov-body" style={{ display: "block", borderTop: 0, padding: 0 }}>
        <label>URL base — {label}</label>
        <input className="input" value={base} placeholder="https://…/v1" spellCheck={false} onChange={(e) => setBase(e.target.value)} />
        <label>Chave de API</label>
        <input
          className="input"
          type="password"
          placeholder={preset === "local" ? "Opcional" : "Chave de API"}
          autoComplete="off"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        {err && <div className="prov-error">{err}</div>}
        <div className="actions-row">
          <button type="button" className="btn primary" disabled={busy} onClick={go}>
            Conectar
          </button>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

function Providers({ openId, setOpenId }: { openId: string | null; setOpenId: (id: string | null) => void }) {
  const providers = useApp((s) => s.providers);
  const [form, setForm] = useState<[string, string] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h3>Provedores</h3>
      <p className="lead">
        Conecte as APIs que você usa. As chaves ficam somente neste computador, no banco local do CEU, e nunca são enviadas ao navegador.
      </p>
      {providers.length ? (
        providers.map((p) =>
          p.preset === "codex" ? (
            <CodexCard key={p.id + (openId === p.id ? ":o" : "")} p={p} initiallyOpen={openId === p.id} />
          ) : (
            <ProviderCard key={p.id + (openId === p.id ? ":o" : "")} p={p} initiallyOpen={openId === p.id} />
          ),
        )
      ) : (
        <p className="lead">Nenhum provedor conectado ainda.</p>
      )}
      <div>
        <p className="lead" style={{ margin: "18px 0 10px" }}>
          Adicionar provedor
        </p>
        <div className="preset-grid">
          {PRESETS.map(([id, name, desc]) => (
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
  return (
    <>
      <h3>Teclado</h3>
      <p className="lead">Tudo no CEU pode ser feito pelo teclado.</p>
      <div className="shortcut-list">
        {SHORTCUTS.map(([label, keys]) => [
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

const num = (n: number) => n.toLocaleString("pt-BR");
const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi" : n >= 1e4 ? Math.round(n / 1e3) + " mil" : num(n));

function Usage() {
  const [u, setU] = useState<UsageReport | null>(null);
  useEffect(() => {
    api.usage().then(setU).catch((e) => toast(e.message));
  }, []);
  if (!u)
    return (
      <>
        <h3>Uso</h3>
        <p className="lead">Carregando…</p>
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
      <h3>Uso</h3>
      <p className="lead">Calculado a partir das suas conversas neste computador. Tokens são os informados por cada provedor; modelos locais podem não informar.</p>
      <div className="stat-tiles">
        <div>
          <b>{num(t.conversations)}</b>
          <span>conversas</span>
        </div>
        <div>
          <b>{num(t.prompts)}</b>
          <span>mensagens enviadas</span>
        </div>
        <div>
          <b>{compact(t.input_tokens)}</b>
          <span>tokens de entrada</span>
        </div>
        <div>
          <b>{compact(t.output_tokens)}</b>
          <span>tokens de saída</span>
        </div>
      </div>
      <Group title="Tokens de saída por dia — últimos 30 dias">
        <div className="day-bars" role="img" aria-label="Tokens de saída por dia nos últimos 30 dias">
          {days.map((d) => (
            <i
              key={d.key}
              style={{ height: d.output ? Math.max(3, (d.output / peak) * 100) + "%" : 0 }}
              data-tip={`${d.date.toLocaleDateString("pt-BR", { day: "numeric", month: "short" })} · ${num(d.output)} tokens · ${d.responses} resposta${d.responses === 1 ? "" : "s"}`}
            />
          ))}
        </div>
        <div className="day-axis">
          <span>{days[0].date.toLocaleDateString("pt-BR", { day: "numeric", month: "short" })}</span>
          <span>hoje</span>
        </div>
      </Group>
      <Group title="Por modelo">
        {!u.by_model.length ? (
          <p className="empty-note">Nenhuma resposta com contagem de tokens ainda.</p>
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
                  {compact(m.output)} <small>· {num(m.responses)} resp.</small>
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
  const [list, setList] = useState<import("../api").Conversation[] | null>(null);
  const load = () => api.conversations(true).then(setList).catch((e) => toast(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!list) return <p className="empty-note">Carregando…</p>;
  if (!list.length) return <p className="empty-note">Nenhuma conversa arquivada.</p>;
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
            {c.title || "Nova conversa"}
          </button>
          <span className="when">{relTime(c.updated_at)}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Restaurar"
            data-tip="Restaurar"
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
            aria-label="Excluir"
            data-tip="Excluir"
            onClick={async () => {
              if (!(await confirmDialog({ title: "Excluir conversa arquivada?", body: `“${c.title || "Nova conversa"}” será excluída.`, confirm: "Excluir", danger: true }))) return;
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
  const count = useApp((s) => s.convs.length);
  const [st, setSt] = useState<StorageReport | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const load = () => api.storage().then(setSt).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <h3>Dados</h3>
      <p className="lead">Conversas, anexos e configurações ficam em data/app.db, na pasta do CEU. Nada sai deste computador além das mensagens enviadas aos provedores.</p>
      <Group title="Armazenamento">
        {st ? (
          <div className="storage">
            <div>
              <span>Banco de dados</span>
              <b>{formatSize(st.database)}</b>
            </div>
            <div>
              <span>Anexos enviados</span>
              <b>
                {formatSize(st.attachments.bytes)} <small>· {num(st.attachments.count)}</small>
              </b>
            </div>
            <div>
              <span>Arquivos das conversas</span>
              <b>
                {formatSize(st.workspaces.bytes)} <small>· {num(st.workspaces.count)}</small>
              </b>
            </div>
          </div>
        ) : (
          <p className="empty-note">Calculando…</p>
        )}
      </Group>
      <Group title="Conversas">
        <Row title="Conversas arquivadas" desc="Saem da barra lateral, mas continuam na busca e podem ser restauradas.">
          <button type="button" className="btn" onClick={() => setShowArchived((x) => !x)}>
            {showArchived ? "Ocultar" : `Gerenciar${st?.archived ? ` (${st.archived})` : ""}`}
          </button>
        </Row>
        {showArchived && <ArchivedList onChange={load} />}
        <Row title="Arquivar todas as conversas" desc="Move todo o histórico para as arquivadas.">
          <button
            type="button"
            className="btn"
            disabled={!count}
            onClick={async () => {
              if (!(await confirmDialog({ title: "Arquivar todas as conversas?", body: `${count} conversa${count === 1 ? "" : "s"} sairão da barra lateral.`, confirm: "Arquivar tudo" }))) return;
              await api.archiveAll().catch((e) => toast(e.message));
              newChat();
              await refreshConvs();
              load();
              toast("Conversas arquivadas");
            }}
          >
            <Icon name="archive" />
            Arquivar tudo
          </button>
        </Row>
        <Row title="Exportar dados" desc="Todas as conversas (com versões e ramificações), memórias e configurações em um arquivo JSON. Chaves de API não são incluídas.">
          <button type="button" className="btn" onClick={() => download("/api/export", "ceu-export.json").catch((e) => toast(e.message))}>
            <Icon name="download" />
            Exportar
          </button>
        </Row>
        <Row title="Excluir todas as conversas" desc="Remove permanentemente o histórico, inclusive as arquivadas, e os anexos.">
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              const ok = await confirmDialog({
                title: "Excluir todas as conversas?",
                body: `Isso apaga ${count} conversa${count === 1 ? "" : "s"}${st?.archived ? ` e ${st.archived} arquivada${st.archived === 1 ? "" : "s"}` : ""}, com todos os anexos. Não é possível desfazer.`,
                confirm: "Excluir tudo",
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
              toast("Todas as conversas foram excluídas");
            }}
          >
            <Icon name="trash" />
            Excluir tudo
          </button>
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
  const section = ALIASES[rawSection] || rawSection;
  const [openId, setOpenId] = useState<string | null>(null);
  const [savedOn, setSavedOn] = useState(false);
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const setSection = (s: string) => useUi.setState((st) => ({ dialogs: st.dialogs.map((d) => (d.id === id ? { ...d, section: s } : d)) }));

  const visible = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return SECTIONS;
    return SECTIONS.filter((s) => norm(s.label + " " + s.keywords).includes(q));
  }, [query]);

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
    <DialogShell id={id} className="settings" label="Configurações">
      <nav className="settings-nav">
        <h2>Configurações</h2>
        <label className="settings-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Buscar"
            aria-label="Buscar nas configurações"
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
        {!visible.length && <p className="settings-nav-empty">Nada encontrado.</p>}
      </nav>
      <div className="settings-body" ref={bodyRef}>
        <button type="button" className="icon-btn settings-close" aria-label="Fechar" onClick={() => closeDialog(id)}>
          <Icon name="close" />
        </button>
        <span className={cx("saved", savedOn && "is-on")}>Salvo</span>
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
