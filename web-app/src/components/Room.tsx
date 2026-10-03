// Rooms (server/rooms.py): a conversation whose participants speak in a configured order. The
// conductor only fires calls — what's here is choosing who speaks, in which order, for how many
// rounds, and following who is speaking now. Templates are ready-made configurations.
import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type RoomConfig, type RoomTemplate } from "../api";
import { Icon } from "../lib/icons";
import { cx } from "../lib/util";
import { activePath, allModels, useApp } from "../state/store";
import { openRoomDialog, saveRoom } from "../state/actions";
import { closeDialog, toast } from "../state/ui";
import { DialogShell } from "./Overlay";
import { ModelGlyph, Name } from "./Participant";

const MAX_ORDER = 8;
const ROUNDS = [1, 2, 3, 4, 5, 6];

/** The order as read aloud: "Luna → Astra → Claude", rounds and the closing speakers. */
export function Sequence({ room, speaking }: { room: RoomConfig; speaking?: { slot: number; finale: boolean } | null }) {
  return (
    <span className="room-seq">
      {room.order.map((ref, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="arr">→</span>}
          <span className={cx("p", speaking && !speaking.finale && speaking.slot === i && "is-speaking")}>
            <ModelGlyph model={ref} />
            <Name model={ref} />
          </span>
        </Fragment>
      ))}
      {room.rounds > 1 && <span className="x">× {room.rounds}</span>}
      {room.finale.map((ref, i) => (
        <Fragment key={"f" + i}>
          <span className="arr">→</span>
          <span className={cx("p", speaking?.finale && speaking.slot === i && "is-speaking")}>
            <ModelGlyph model={ref} />
            <Name model={ref} />
            {i === 0 && <span className="fin">no final</span>}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** Who is speaking now in the open Room (from the streaming turn's call). */
function useSpeaking() {
  return useApp((s) => {
    const cur = s.current;
    if (!cur?.conv.room) return null;
    const live = s.generating.map((id) => cur.msgs[id]).find((m) => m?.call?.surface === "chat" && m.call.room);
    const turn = live?.call?.surface === "chat" ? live.call.room : null;
    if (!turn) return null;
    const n = cur.conv.room.order.length;
    const k = turn.turn - 1;
    return turn.finale ? { slot: k - n * turn.rounds, finale: true, turn } : { slot: k % n, finale: false, turn };
  });
}

/** Topbar: the Room's sequence, with the participant speaking now lit. Opens the editor. */
export function RoomBadge() {
  const room = useApp((s) => s.current?.conv.room || null);
  const id = useApp((s) => s.current?.conv.id);
  const speaking = useSpeaking();
  if (!room || !id) return null;
  const tip = speaking ? (speaking.finale ? "Encerramento" : `Rodada ${speaking.turn.round} de ${speaking.turn.rounds} · turno ${speaking.turn.turn} de ${speaking.turn.of}`) : "Participantes e ordem da Room";
  return (
    <button type="button" className={cx("room-badge", speaking && "is-live")} data-tip={tip} onClick={() => openRoomDialog(id)}>
      <span className="k">Room</span>
      <Sequence room={room} speaking={speaking} />
    </button>
  );
}

/** An empty Room: what will happen when the user writes. */
export function RoomIntro() {
  const conv = useApp((s) => s.current?.conv);
  if (!conv?.room) return null;
  const room = conv.room;
  const turns = room.order.length * room.rounds + room.finale.length;
  return (
    <div className="agent-intro room-intro">
      <b>Room</b>
      <Sequence room={room} />
      <p>
        Escreva a abertura. Cada participante responde na ordem, vendo o que os anteriores disseram — {turns} falas no total
        {room.tools ? ", com as ferramentas do Chat" : ", sem ferramentas"}. Para falar com um só, use <kbd>@</kbd>.
      </p>
      <button type="button" className="btn" onClick={() => openRoomDialog(conv.id)}>
        Editar participantes
      </button>
    </div>
  );
}

/** Create or edit a Room. */
export function RoomDialog({ id, convId }: { id: number; convId: string | null }) {
  const providers = useApp((s) => s.providers);
  const models = allModels(providers);
  const existing = useApp((s) => (convId && s.current?.conv.id === convId ? s.current.conv.room : null));
  const running = useApp((s) => !!convId && s.current?.conv.id === convId && (s.current.conv.room_running || activePath(s.current).some((m) => m.status === "streaming")));
  const [templates, setTemplates] = useState<RoomTemplate[]>([]);
  const [template, setTemplate] = useState<string | null>(existing?.template || null);
  const [hints, setHints] = useState<{ order: string[]; finale: string[] } | null>(null);
  const [title, setTitle] = useState("");
  const [order, setOrder] = useState<(string | null)[]>(existing?.order || [models[0]?.ref || null, models[1]?.ref || null]);
  const [rounds, setRounds] = useState(existing?.rounds || 1);
  const [finale, setFinale] = useState<string | null>(existing?.finale[0] || null);
  const [tools, setTools] = useState(!!existing?.tools);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.roomTemplates().then(setTemplates).catch(() => {});
  }, []);

  const applyTemplate = (tid: string) => {
    const t = templates.find((x) => x.id === tid);
    setTemplate(t ? t.id : null);
    setHints(t ? t.slots : null);
    if (!t) return;
    setOrder(t.order);
    setRounds(t.rounds);
    setFinale(t.finale[0] || null);
    if (!title) setTitle(t.name);
  };

  const filled = order.filter((r): r is string => !!r);
  const distinct = new Set([...filled, ...(finale ? [finale] : [])]).size;
  const ready = filled.length === order.length && order.length > 0 && distinct >= 2;
  const preview: RoomConfig | null = ready ? { order: filled, rounds, finale: finale ? [finale] : [], tools, template } : null;
  const turns = order.length * rounds + (finale ? 1 : 0);

  const move = (i: number, d: number) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setOrder(next);
  };
  const close = () => closeDialog(id);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preview) return;
    setBusy(true);
    try {
      await saveRoom(convId, preview, title.trim());
      close();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  const options = useMemo(
    () =>
      models.map((m) => (
        <option key={m.ref} value={m.ref}>
          {m.name.split(/[\\/]/).pop()} · {m.provider.name}
        </option>
      )),
    [models],
  );

  return (
    <DialogShell id={id} className="agent-dialog room-dialog" label={convId ? "Editar Room" : "Nova Room"}>
      <form onSubmit={submit} className="agent-form">
        <h3>{convId ? "Editar Room" : "Nova Room"}</h3>
        <p className="lead">
          Uma conversa em que vários modelos falam em sequência. Cada um vê o que os anteriores disseram, com autoria; um participante pode
          aparecer mais de uma vez. Quando você escreve, a sequência roda inteira; com <kbd>@</kbd> você fala com um só.
        </p>
        {!convId && (
          <div className="af-grid">
            <label className="af-field">
              <span>Ponto de partida</span>
              <select className="select" value={template || ""} onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">Do zero</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="af-field">
              <span>Nome (opcional)</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Gerado após a primeira rodada" />
            </label>
          </div>
        )}
        {template && <p className="af-note room-tpl-note">{templates.find((t) => t.id === template)?.description}</p>}
        <div className="af-field">
          <span>Ordem de fala</span>
          <ol className="room-order">
            {order.map((ref, i) => (
              <li key={i}>
                <span className="n">{i + 1}</span>
                {ref ? <ModelGlyph model={ref} /> : <span className="glyph-gap" />}
                <select className="select" value={ref || ""} onChange={(e) => setOrder(order.map((r, j) => (j === i ? e.target.value || null : r)))} aria-label={`Participante ${i + 1}`}>
                  {!ref && <option value="">{hints?.order[i] ? `Escolha (sugestão: ${hints.order[i]})` : "Escolha um modelo"}</option>}
                  {ref && !models.some((m) => m.ref === ref) && <option value={ref}>{ref.split("::").pop()} (indisponível)</option>}
                  {options}
                </select>
                <button type="button" className="icon-btn" aria-label="Subir" data-tip="Subir" disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="arrow-up" />
                </button>
                <button type="button" className="icon-btn" aria-label="Descer" data-tip="Descer" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="arrow-down" />
                </button>
                <button type="button" className="icon-btn" aria-label="Remover" data-tip="Remover" disabled={order.length <= 1} onClick={() => setOrder(order.filter((_, j) => j !== i))}>
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="btn ghost room-add"
            disabled={order.length >= MAX_ORDER}
            onClick={() => setOrder([...order, models.find((m) => !order.includes(m.ref))?.ref || models[0]?.ref || null])}
          >
            <Icon name="new" /> Adicionar participante
          </button>
        </div>
        <div className="af-grid">
          <label className="af-field">
            <span>Rodadas</span>
            <select className="select" value={rounds} onChange={(e) => setRounds(+e.target.value)}>
              {ROUNDS.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 rodada" : `${n} rodadas`}
                </option>
              ))}
            </select>
          </label>
          <label className="af-field">
            <span>No final (opcional)</span>
            <select className="select" value={finale || ""} onChange={(e) => setFinale(e.target.value || null)}>
              <option value="">{hints?.finale[0] && !finale ? `Ninguém (sugestão: ${hints.finale[0]})` : "Ninguém"}</option>
              {options}
            </select>
          </label>
        </div>
        <label className="room-tools">
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} />
          <span>
            <b>Ferramentas do Chat</b>
            <span>Os participantes podem rodar código e gravar arquivos na pasta desta conversa. Desligado, eles só conversam.</span>
          </span>
        </label>
        <div className="room-preview" aria-live="polite">
          {preview ? (
            <>
              <Sequence room={preview} />
              <span className="t">{turns} falas por mensagem sua</span>
            </>
          ) : (
            <span className="t">{distinct < 2 && filled.length === order.length ? "Escolha pelo menos dois modelos diferentes." : "Escolha um modelo para cada lugar."}</span>
          )}
        </div>
        {running && <p className="af-note">A Room está falando agora: a nova configuração vale a partir da próxima mensagem.</p>}
        <div className="row">
          <button type="button" className="btn ghost" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={busy || !preview}>
            {convId ? "Salvar" : "Criar Room"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
