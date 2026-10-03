import { h, debounce, kbd } from './util.js';
import { icon } from './icons.js';
import { S, emit, allModels } from './state.js';
import { api } from './api.js';
import { openDialog, confirmDialog, toast } from './ui.js';

const SECTIONS = [
  ['general', 'Geral', 'sliders'],
  ['instructions', 'Instruções', 'text'],
  ['providers', 'Provedores', 'plug'],
  ['shortcuts', 'Atalhos', 'keyboard'],
  ['data', 'Dados', 'database'],
];

export const SHORTCUTS = [
  ['Nova conversa', 'Ctrl ⇧ O'],
  ['Buscar e comandos', 'Ctrl K'],
  ['Trocar modelo', 'Ctrl .'],
  ['Alternar barra lateral', 'Ctrl B'],
  ['Conversa anterior / seguinte', 'Alt ↑ / Alt ↓'],
  ['Focar o campo de mensagem', '⇧ Esc'],
  ['Editar a última mensagem', '↑ (campo vazio)'],
  ['Interromper a resposta', 'Esc'],
  ['Copiar a última resposta', 'Ctrl ⇧ C'],
  ['Excluir a conversa', 'Ctrl ⇧ ⌫'],
  ['Configurações', 'Ctrl ,'],
  ['Atalhos de teclado', 'Ctrl /'],
];

let saved;
const lastErrors = new Map(); // providerId -> last connection error, shown inside its card
function flashSaved() {
  saved?.classList.add('is-on');
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => saved?.classList.remove('is-on'), 1200);
}

async function save(patch) {
  try {
    S.settings = await api.settings(patch);
    emit('settings-changed', patch);
    flashSaved();
  } catch (e) { toast(e.message); }
}

function seg(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  for (const [v, label] of options) {
    const b = h('button', { type: 'button', class: String(v) === String(value) ? 'is-on' : '', role: 'radio', 'aria-checked': String(String(v) === String(value)) }, label);
    b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      onChange(v);
    });
    el.append(b);
  }
  return el;
}

function sw(on, onChange) {
  const b = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(!!on) });
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(v));
    onChange(v);
  });
  return b;
}

function row(title, desc, control) {
  return h('div', { class: 'field-row' }, h('div', { class: 'l' }, h('b', {}, title), desc ? h('span', {}, desc) : null), control);
}

function modelSelect(value, { allowSame = false } = {}) {
  const sel = h('select', { class: 'select' });
  if (allowSame) sel.append(h('option', { value: '' }, 'O mesmo da conversa'));
  for (const m of allModels()) sel.append(h('option', { value: m.ref, selected: m.ref === value }, `${m.name} — ${m.provider.name}`));
  if (!allowSame && !allModels().length) sel.append(h('option', { value: '' }, 'Nenhum modelo'));
  return sel;
}

// ------------------------------------------------------------------ sections

function general() {
  const s = S.settings;
  const theme = seg([['system', 'Sistema'], ['dark', 'Escuro'], ['light', 'Claro']], s.theme, (v) => save({ theme: v }));
  const size = seg([[14, 'P'], [15, 'M'], [16, 'G'], [17, 'GG']], s.font_size, (v) => save({ font_size: Number(v) }));
  const send = h('select', { class: 'select' },
    h('option', { value: 'enter', selected: s.send_key === 'enter' }, 'Enter envia'),
    h('option', { value: 'ctrl-enter', selected: s.send_key === 'ctrl-enter' }, `${kbd('Ctrl')}+Enter envia`));
  send.addEventListener('change', () => save({ send_key: send.value }));
  const def = modelSelect(s.default_model);
  def.addEventListener('change', () => save({ default_model: def.value || null }));
  const titles = modelSelect(s.title_model, { allowSame: true });
  titles.value = s.title_model || '';
  titles.addEventListener('change', () => save({ title_model: titles.value || null }));
  return [
    h('h3', {}, 'Geral'),
    h('p', { class: 'lead' }, 'Aparência e comportamento do aplicativo. As alterações são salvas automaticamente.'),
    row('Tema', null, theme),
    row('Tamanho do texto', 'Aplica-se às mensagens e ao campo de texto.', size),
    row('Envio', 'Com Ctrl+Enter, Enter sempre insere uma nova linha.', send),
    row('Espaço animado', 'Partículas ao fundo que aceleram enquanto um modelo responde.', sw(s.ambient, (v) => save({ ambient: v }))),
    row('Modelo padrão', 'Usado em conversas novas.', def),
    row('Modelo para títulos', 'Gera o título de cada conversa depois da primeira resposta.', titles),
  ];
}

function instructions() {
  const ta = h('textarea', { class: 'textarea', placeholder: 'Ex.: Responda em português, de forma direta. Sou desenvolvedor Python; prefira exemplos com tipagem.', rows: '10' });
  ta.value = S.settings.instructions || '';
  const persist = debounce(() => save({ instructions: ta.value }), 500);
  ta.addEventListener('input', persist);
  return [
    h('h3', {}, 'Instruções personalizadas'),
    h('p', { class: 'lead' }, 'Enviadas como instrução de sistema em todas as conversas, com qualquer modelo. Valem a partir da próxima mensagem.'),
    ta,
  ];
}

function codexLoginControl(p, rerender) {
  const wrap = h('div', { class: 'codex-login' });
  const statusEl = h('div', { class: 'prov-error', style: { color: 'var(--ink-2)' } }, 'Verificando conta…');
  const btn = h('button', { type: 'button', class: 'btn primary' }, 'Entrar com ChatGPT');
  let cancelled = false;
  let loginId = null;

  const showConnected = (acc) => {
    statusEl.textContent = `Conectado como ${acc.email || '?'}${acc.plan ? ` (plano ${acc.plan})` : ''}.`;
    statusEl.style.color = '';
    btn.textContent = 'Entrar com outra conta';
    btn.disabled = false;
  };
  const showDisconnected = (msg) => {
    statusEl.textContent = msg || 'Nenhuma conta conectada.';
    btn.textContent = 'Entrar com ChatGPT';
    btn.disabled = false;
  };

  const refreshStatus = async () => {
    try {
      const acc = await api.codexAccount();
      if (acc.connected) showConnected(acc); else showDisconnected(acc.error);
    } catch (e) { showDisconnected(e.message); }
  };

  const pollLogin = async (id) => {
    while (!cancelled) {
      let res;
      try {
        res = await api.codexLoginWait(id);
      } catch (e) {
        statusEl.textContent = e.message;
        statusEl.style.color = 'var(--danger)';
        btn.disabled = false;
        btn.textContent = 'Tentar novamente';
        return;
      }
      if (cancelled) return;
      if (res.done) {
        showConnected(res.account);
        toast('Conectado ao ChatGPT');
        await emit('providers-changed');
        rerender(p.id);
        return;
      }
      // res.done === false: server-side wait timed out after ~25s, keep polling.
    }
  };

  btn.addEventListener('click', async () => {
    if (loginId) { // currently waiting — treat click as cancel
      cancelled = true;
      api.codexLoginCancel(loginId).catch(() => {});
      loginId = null;
      showDisconnected('Login cancelado.');
      return;
    }
    btn.disabled = true;
    cancelled = false;
    statusEl.style.color = '';
    statusEl.textContent = 'Abrindo o navegador para login…';
    try {
      const res = await api.codexLoginStart();
      loginId = res.loginId;
      statusEl.textContent = 'Aguardando você concluir o login no navegador…';
      btn.disabled = false;
      btn.textContent = 'Cancelar';
      pollLogin(loginId);
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.style.color = 'var(--danger)';
      btn.disabled = false;
    }
  });

  refreshStatus();
  wrap.append(statusEl, btn);
  return wrap;
}

function providerCard(p, open, rerender) {
  if (p.preset === 'codex') return codexProviderCard(p, open, rerender);
  const card = h('div', { class: 'prov' + (open ? ' is-open' : '') });
  const status = !p.enabled ? '' : p.models.length ? 'ok' : 'err';
  const head = h('div', { class: 'prov-head', role: 'button', tabindex: '0', 'aria-expanded': String(open) },
    h('span', { class: 'dot ' + status }),
    h('span', { class: 'n' }, p.name),
    h('span', { class: 'd' }, `${p.enabled ? `${p.models.length} modelo${p.models.length === 1 ? '' : 's'}` : 'Desativado'} · ${p.base_url}`),
    h('span', { class: 'chev', html: icon('chevron-right') }));
  const toggle = () => { card.classList.toggle('is-open'); head.setAttribute('aria-expanded', String(card.classList.contains('is-open'))); };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

  const name = h('input', { class: 'input', value: p.name });
  const base = h('input', { class: 'input', value: p.base_url, spellcheck: 'false' });
  const key = h('input', { class: 'input', type: 'password', placeholder: p.has_key ? `Chave salva ${p.key_hint}` : (p.preset === 'local' ? 'Opcional' : 'Cole sua chave de API'), autocomplete: 'off', spellcheck: 'false' });
  const example = p.kind === 'anthropic' ? 'claude-opus-5' : p.preset === 'openrouter' ? 'anthropic/claude-opus-5' : p.preset === 'local' ? 'nome-do-modelo' : 'gpt-4.1-mini';
  const custom = h('input', { class: 'input', placeholder: `ID do modelo, ex.: ${example}`, spellcheck: 'false' });
  const err = h('div', { class: 'prov-error' }, lastErrors.get(p.id) || '');
  const setErr = (msg) => { err.textContent = msg || ''; if (msg) lastErrors.set(p.id, msg); else lastErrors.delete(p.id); };
  const models = h('div', { class: 'prov-models' });
  const drawModels = (list) => {
    models.innerHTML = '';
    if (!list.length) { models.textContent = 'Nenhum modelo carregado.'; return; }
    models.append(`${list.length} modelo${list.length === 1 ? '' : 's'}: `);
    for (const m of list.slice(0, 40)) models.append(h('code', {}, m.id));
    if (list.length > 40) models.append(`e mais ${list.length - 40}`);
  };
  drawModels(p.models);

  const apply = async (patch, label) => {
    setErr('');
    try {
      const res = await api.updateProvider(p.id, patch);
      setErr(res.error);
      await emit('providers-changed');
      if (label && !res.error) toast(label);
      rerender(p.id);
    } catch (e) { setErr(e.message); }
  };
  name.addEventListener('change', () => apply({ name: name.value.trim() || p.name }));
  base.addEventListener('change', () => apply({ base_url: base.value.trim() }));
  key.addEventListener('change', () => { if (key.value.trim()) apply({ api_key: key.value.trim() }, 'Chave salva'); });

  const refresh = h('button', { type: 'button', class: 'btn', html: icon('retry') }, 'Atualizar modelos');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    setErr('');
    try {
      const res = await api.refreshProvider(p.id);
      setErr(res.error);
      drawModels(res.provider.models);
      await emit('providers-changed');
    } catch (e) { setErr(e.message); }
    refresh.disabled = false;
  });
  const addBtn = h('button', { type: 'button', class: 'btn' }, 'Adicionar');
  addBtn.addEventListener('click', () => { if (custom.value.trim()) apply({ add_model: custom.value.trim() }, 'Modelo adicionado'); });
  custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
  const enabled = sw(p.enabled, (v) => apply({ enabled: v }));
  const remove = h('button', { type: 'button', class: 'btn danger', html: icon('trash') }, 'Remover');
  remove.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Remover ${p.name}?`, body: 'A chave e a lista de modelos serão apagadas. Conversas existentes continuam salvas.', confirm: 'Remover', danger: true });
    if (!ok) return;
    await api.deleteProvider(p.id);
    await emit('providers-changed');
    rerender();
  });

  card.append(head, h('div', { class: 'prov-body' },
    h('label', {}, 'Nome'), name,
    h('label', {}, 'URL base'), base,
    h('label', {}, 'Chave de API'), key,
    models,
    h('label', {}, 'Adicionar modelo manualmente'), h('div', { style: { display: 'flex', gap: '6px' } }, custom, addBtn),
    err,
    h('div', { class: 'actions-row' }, refresh, h('div', { class: 'grow' }), h('span', { style: { fontSize: '12px', color: 'var(--ink-2)' } }, 'Ativo'), enabled, remove)));
  return card;
}

function codexProviderCard(p, open, rerender) {
  const card = h('div', { class: 'prov' + (open ? ' is-open' : '') });
  const status = !p.enabled ? '' : p.models.length ? 'ok' : 'err';
  const head = h('div', { class: 'prov-head', role: 'button', tabindex: '0', 'aria-expanded': String(open) },
    h('span', { class: 'dot ' + status }),
    h('span', { class: 'n' }, p.name),
    h('span', { class: 'd' }, p.enabled ? `${p.models.length} modelo${p.models.length === 1 ? '' : 's'} · login com ChatGPT` : 'Desativado'),
    h('span', { class: 'chev', html: icon('chevron-right') }));
  const toggle = () => { card.classList.toggle('is-open'); head.setAttribute('aria-expanded', String(card.classList.contains('is-open'))); };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

  const models = h('div', { class: 'prov-models' });
  const drawModels = (list) => {
    models.innerHTML = '';
    if (!list.length) { models.textContent = 'Nenhum modelo carregado ainda — entre com sua conta ChatGPT.'; return; }
    models.append(`${list.length} modelo${list.length === 1 ? '' : 's'}: `);
    for (const m of list.slice(0, 40)) models.append(h('code', {}, m.id));
  };
  drawModels(p.models);

  const refresh = h('button', { type: 'button', class: 'btn', html: icon('retry') }, 'Atualizar modelos');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    try {
      const res = await api.refreshProvider(p.id);
      drawModels(res.provider.models);
      await emit('providers-changed');
    } catch (e) { toast(e.message); }
    refresh.disabled = false;
  });
  const enabled = sw(p.enabled, async (v) => { await api.updateProvider(p.id, { enabled: v }); await emit('providers-changed'); rerender(p.id); });
  const remove = h('button', { type: 'button', class: 'btn danger', html: icon('trash') }, 'Remover');
  remove.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Remover ${p.name}?`, body: 'Isso só desconecta o CEU — sua sessão do Codex CLI continua logada. Conversas existentes continuam salvas.', confirm: 'Remover', danger: true });
    if (!ok) return;
    await api.deleteProvider(p.id);
    await emit('providers-changed');
    rerender();
  });

  card.append(head, h('div', { class: 'prov-body' },
    h('p', { class: 'lead', style: { margin: '0 0 4px' } },
      'Usa o app-server do Codex CLI, já instalado, para autenticar com sua conta ChatGPT (Plus/Pro/Team). ' +
      'O CEU nunca vê seu login nem tokens — só abre o navegador e pergunta ao Codex se deu certo.'),
    codexLoginControl(p, rerender),
    models,
    h('div', { class: 'actions-row' }, refresh, h('div', { class: 'grow' }), h('span', { style: { fontSize: '12px', color: 'var(--ink-2)' } }, 'Ativo'), enabled, remove)));
  return card;
}

function addProviderForm(rerender) {
  const wrap = h('div');
  const presets = [
    ['anthropic', 'Anthropic', 'Claude — Opus, Sonnet, Haiku'],
    ['openai', 'OpenAI', 'Modelos GPT pela API da OpenAI'],
    ['codex', 'ChatGPT (Codex)', 'Login com sua conta ChatGPT — sem chave de API'],
    ['openrouter', 'OpenRouter', 'Centenas de modelos com uma chave'],
    ['local', 'Local', 'llama.cpp, Ollama, LM Studio'],
    ['custom', 'Outro', 'Qualquer API compatível com OpenAI'],
  ];
  const grid = h('div', { class: 'preset-grid' });
  const form = h('div');
  for (const [id, name, desc] of presets) {
    const b = h('button', { type: 'button', class: 'preset' }, h('b', {}, name), h('span', {}, desc));
    if (id === 'codex') {
      b.addEventListener('click', async () => {
        if (S.providers.some((p) => p.preset === 'codex')) { rerender(S.providers.find((p) => p.preset === 'codex').id); return; }
        b.disabled = true;
        try {
          const res = await api.createProvider({ preset: 'codex' });
          await emit('providers-changed');
          rerender(res.provider.id);
        } catch (e) { toast(e.message); b.disabled = false; }
      });
    } else {
      b.addEventListener('click', () => showForm(id, name));
    }
    grid.append(b);
  }
  const showForm = (preset, label) => {
    const def = S.presets[preset];
    const base = h('input', { class: 'input', value: def.base_url, placeholder: 'https://…/v1', spellcheck: 'false' });
    const key = h('input', { class: 'input', type: 'password', placeholder: preset === 'local' ? 'Opcional' : 'Chave de API', autocomplete: 'off', autofocus: true });
    const err = h('div', { class: 'prov-error' });
    const go = h('button', { type: 'button', class: 'btn primary' }, 'Conectar');
    go.addEventListener('click', async () => {
      go.disabled = true;
      err.textContent = '';
      try {
        const res = await api.createProvider({ preset, name: preset === 'local' || preset === 'custom' ? undefined : label, base_url: base.value.trim(), api_key: key.value.trim() });
        await emit('providers-changed');
        if (res.error) lastErrors.set(res.provider.id, res.error);
        if (res.error) toast(`${label} adicionado, mas não conectou.`, { duration: 5000 });
        else toast(`${label} conectado — ${res.provider.models.length} modelos`);
        rerender(res.provider.id);
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    });
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    form.innerHTML = '';
    form.append(h('div', { class: 'prov', style: { padding: '4px 14px 14px' } },
      h('div', { class: 'prov-body', style: { display: 'block', borderTop: '0', padding: '0' } },
        h('label', {}, `URL base — ${label}`), base,
        h('label', {}, 'Chave de API'), key,
        err,
        h('div', { class: 'actions-row' }, go, h('button', { type: 'button', class: 'btn ghost', onclick: () => { form.innerHTML = ''; } }, 'Cancelar')))));
    key.focus();
  };
  wrap.append(h('p', { class: 'lead', style: { margin: '18px 0 10px' } }, 'Adicionar provedor'), grid, form);
  return wrap;
}

function providers(rerender, openId) {
  const list = S.providers.map((p) => providerCard(p, p.id === openId, rerender));
  return [
    h('h3', {}, 'Provedores'),
    h('p', { class: 'lead' }, 'Conecte as APIs que você usa. As chaves ficam somente neste computador, no banco local do CEU, e nunca são enviadas ao navegador.'),
    ...(list.length ? list : [h('p', { class: 'lead' }, 'Nenhum provedor conectado ainda.')]),
    addProviderForm(rerender),
  ];
}

function shortcuts() {
  const grid = h('div', { class: 'shortcut-list' });
  for (const [label, keys] of SHORTCUTS) {
    grid.append(h('div', {}, label), h('div', { class: 'k' }, ...keys.split(' / ').map((k) => h('kbd', {}, kbd(k)))));
  }
  return [h('h3', {}, 'Atalhos de teclado'), h('p', { class: 'lead' }, 'Tudo no CEU pode ser feito pelo teclado.'), grid];
}

function data() {
  const del = h('button', { type: 'button', class: 'btn danger', html: icon('trash') }, 'Excluir todas');
  del.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Excluir todas as conversas?', body: `Isso apaga ${S.convs.length} conversa${S.convs.length === 1 ? '' : 's'} e todos os anexos. Não é possível desfazer.`, confirm: 'Excluir tudo', danger: true });
    if (!ok) return;
    await api.deleteAll();
    emit('all-deleted');
    toast('Todas as conversas foram excluídas');
  });
  return [
    h('h3', {}, 'Dados'),
    h('p', { class: 'lead' }, 'Conversas, anexos e configurações ficam em data/app.db, na pasta do CEU. Cada conversa pode ser exportada em Markdown pelo menu dela.'),
    row('Excluir todas as conversas', 'Remove permanentemente o histórico e os anexos.', del),
  ];
}

// ------------------------------------------------------------------ dialog

export function openSettings(section = 'general') {
  const nav = h('nav', { class: 'settings-nav' }, h('h2', {}, 'Configurações'));
  const body = h('div', { class: 'settings-body' });
  const el = h('div', { class: 'settings', 'aria-label': 'Configurações' }, nav, body);
  let current = section;
  saved = h('span', { class: 'saved' }, 'Salvo');

  const render = (openId) => {
    body.innerHTML = '';
    const closeBtn = h('button', { type: 'button', class: 'icon-btn settings-close', 'aria-label': 'Fechar', html: icon('close') });
    closeBtn.addEventListener('click', () => close());
    const content = { general, instructions, providers: () => providers(render, openId), shortcuts, data }[current]();
    body.append(closeBtn, saved, ...content);
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.s === current));
  };
  for (const [id, label, ic] of SECTIONS) {
    const b = h('button', { type: 'button', 'data-s': id, html: icon(ic) }, label);
    b.addEventListener('click', () => { current = id; render(); });
    nav.append(b);
  }
  const close = openDialog(el);
  render();
}
