"""Rooms: a conversation whose participants speak in a configured order.

A Room is a Chat conversation with a `room` configuration:

  {"order": [model refs], "rounds": int, "finale": [model refs], "tools": bool, "template": id | None}

When the user writes in it (without `@`), a conductor fires one chat call (calls.py) per
participant, in order, for each round, then the finale. Each turn is an ordinary call answered by
generation.launch under the previous one, so authorship, chronology and the per-speaker projection
are exactly those of `@modelo`; the call carries the turn's place in the sequence
(`"room": {"round", "rounds", "turn", "of", "finale"}`). A participant may appear several times
(A → B → C → A). The conductor only sequences: no conditions, judge, votes or branching. A turn
that fails is left in the thread as an error and the next participant speaks. The cursor is
persisted so a server restart can continue at the next participant; an explicit stop ends the run.

Tools: a Room's participants don't get the Chat tools (code, files) unless the room turns them on
(`tools`). A plain `@modelo` call outside a Room keeps them, as before.

Templates are ready-made configurations. Their slots name models loosely (`match`: words that must
all appear in the model's name or id) and are resolved against the models the user has; a slot no
model matches is left for the user to choose.
"""
import re
import threading

from . import calls, db, generation

MAX_ROUNDS = 6
MAX_ORDER = 8
MAX_FINALE = 2

TEMPLATES = [
    {
        "id": "cadeia",
        "name": "Revisão em cadeia",
        "description": "Cada modelo lê o que os anteriores disseram e acrescenta ou corrige; um modelo pequeno "
                       "fecha com um resumo curto.",
        "order": [{"match": "luna"}, {"match": "astra"}, {"match": "claude"}],
        "rounds": 1,
        "finale": [{"match": "qwen 1b"}],
    },
    {
        "id": "debate",
        "name": "Debate em três rodadas",
        "description": "Dois modelos alternam a palavra por três rodadas sobre o que você propuser.",
        "order": [{"match": ""}, {"match": ""}],
        "rounds": 3,
        "finale": [],
    },
]

_runs = {}  # conversation id -> Run
_lock = threading.Lock()


class Run:
    pass


def running(conversation_id):
    with _lock:
        return conversation_id in _runs


# ---------------------------------------------------------------- configuration

def _model_ref(ref):
    try:
        return calls.normalize({"surface": "chat", "target": ref})["target"]
    except ValueError as e:
        raise ValueError(f"Participante inválido: {e}")


def normalize(raw):
    """A validated room configuration. Raises ValueError with a user-facing message."""
    if not isinstance(raw, dict):
        raise ValueError("Configuração de Room inválida.")
    order = [_model_ref(r) for r in (raw.get("order") or [])][:MAX_ORDER]
    finale = [_model_ref(r) for r in (raw.get("finale") or []) if r][:MAX_FINALE]
    if not order:
        raise ValueError("Escolha os participantes da Room.")
    if len(set(order + finale)) < 2:
        raise ValueError("Uma Room precisa de pelo menos dois modelos diferentes.")
    try:
        rounds = max(1, min(int(raw.get("rounds") or 1), MAX_ROUNDS))
    except (TypeError, ValueError):
        rounds = 1
    template = raw.get("template") if any(t["id"] == raw.get("template") for t in TEMPLATES) else None
    return {"order": order, "rounds": rounds, "finale": finale, "tools": bool(raw.get("tools")), "template": template}


def sequence(room):
    """Who speaks, in order: [(ref, turn)] where turn is what the call records."""
    turns = [(ref, {"round": r, "rounds": room["rounds"], "finale": False})
             for r in range(1, room["rounds"] + 1) for ref in room["order"]]
    turns += [(ref, {"round": room["rounds"], "rounds": room["rounds"], "finale": True}) for ref in room.get("finale") or []]
    for i, (_ref, turn) in enumerate(turns):
        turn.update(turn=i + 1, of=len(turns))
    return turns


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _resolve(slot, models):
    words = _norm(slot.get("match")).split()
    if not words:
        return None
    for ref, name in models:
        hay = " " + _norm(name) + " " + _norm(ref.split("::", 1)[1]) + " "
        if all(f" {w}" in hay for w in words):  # each word starts a word of the name or id
            return ref
    return None


def templates():
    """The templates with their slots resolved against the user's enabled models (None = to choose)."""
    models = [(f"{p['id']}::{m['id']}", m.get("name") or m["id"])
              for p in db.list_providers() if p["enabled"] for m in p["models"]]
    out = []
    for t in TEMPLATES:
        out.append(dict(t, order=[_resolve(s, models) for s in t["order"]],
                        finale=[_resolve(s, models) for s in t["finale"]],
                        slots={"order": [s["match"] for s in t["order"]], "finale": [s["match"] for s in t["finale"]]}))
    return out


def default_title(room):
    names = {}
    return "Room · " + " → ".join(calls.label(r, names) for r in room["order"])


# ---------------------------------------------------------------- conductor

def start(conv, parent_id):
    """Starts a run after the user's message `parent_id`: launches the first turn and returns its
    placeholder; a thread carries the rest of the sequence."""
    turns = sequence(conv["room"])
    run = Run()
    with _lock:
        if conv["id"] in _runs or db.get_room_run(conv["id"]):
            raise ValueError("A Room já está em andamento.")
        _runs[conv["id"]] = run
    state = {"turns": turns, "index": 0, "parent_id": parent_id, "message_id": None}
    db.set_room_run(conv["id"], state)
    try:
        first = _ensure_current(conv["id"], state)
        if not first:
            raise RuntimeError("Não foi possível iniciar a sequência da Room.")
    except Exception:
        db.set_room_run(conv["id"], None)
        with _lock:
            _runs.pop(conv["id"], None)
        raise
    threading.Thread(target=_conduct, args=(run, conv["id"]), daemon=True,
                     name=f"room-{conv['id'][:6]}").start()
    return first


def _turn(conv, parent_id, ref, turn):
    """One participant's turn: a call, under the previous turn. A participant that can't be called
    (its provider was removed or disabled) leaves an error in the thread instead."""
    try:
        call = dict(calls.normalize({"surface": "chat", "target": ref}), room=turn)
    except ValueError as e:
        msg = db.create_message(conv["id"], parent_id, "assistant", model=ref, status="error",
                                call={"surface": "chat", "target": ref, "effort": None, "room": turn})
        db.update_message(msg["id"], error=str(e), finished_at=msg["created_at"])
        db.update_conversation(conv["id"], {"current_leaf_id": msg["id"]}, touch=True)
        return db.get_message(msg["id"])
    return generation.launch(conv, parent_id, ref, None, call=call)


def _wait(message_id):
    g = generation.get(message_id)
    cursor = 0
    while g and not g.done:
        _events, cursor, _done = g.wait(cursor, timeout=5)
    return db.get_message(message_id)


def _ensure_current_id(conversation_id, state):
    parent_id = state.get("parent_id")
    turn_number = state.get("index", -1) + 1
    return next((m["id"] for m in db.list_messages(conversation_id)
                 if m["parent_id"] == parent_id and
                 (m.get("call") or {}).get("room", {}).get("turn") == turn_number), None)


def _ensure_current(conversation_id, state):
    """Reuse a persisted placeholder if a crash happened before the cursor update."""
    message_id = state.get("message_id") or _ensure_current_id(conversation_id, state)
    msg = db.get_message(message_id) if message_id else None
    if msg:
        if msg["id"] != state.get("message_id"):
            state["message_id"] = msg["id"]
            db.set_room_run(conversation_id, state)
        return msg
    if state["index"] >= len(state["turns"]):
        return None
    conv = db.get_conversation(conversation_id)
    if not conv:
        return None
    ref, turn = state["turns"][state["index"]]
    msg = _turn(conv, state["parent_id"], ref, turn)
    state["message_id"] = msg["id"]
    db.set_room_run(conversation_id, state)
    return msg


def _conduct(run, conversation_id):
    try:
        while True:
            with _lock:
                if _runs.get(conversation_id) is not run:
                    return
            state = db.get_room_run(conversation_id)
            if not state:
                break
            msg = _ensure_current(conversation_id, state)
            if not msg:
                break
            msg = _wait(msg["id"])
            # Explicit stops clear the cursor before cancelling the generation.
            if not db.get_room_run(conversation_id):
                return
            if not msg or msg["status"] == "stopped":
                break
            state["parent_id"] = msg["id"]
            state["index"] += 1
            state["message_id"] = None
            if state["index"] >= len(state["turns"]):
                break
            db.set_room_run(conversation_id, state)
    except Exception:  # noqa: BLE001 - a broken run must not leave the room marked as running
        import traceback
        traceback.print_exc()
    finally:
        with _lock:
            owned = _runs.get(conversation_id) is run
            if owned:
                _runs.pop(conversation_id, None)
        if owned and db.get_room_run(conversation_id):
            # A Python exception must not strand the Room. A process crash skips finally and
            # leaves the cursor for recover() at the next boot.
            db.set_room_run(conversation_id, None)
        generation.bus.publish({"type": "conversation", "conversation_id": conversation_id})


def stop(conversation_id):
    """Clear a Room cursor so an explicit stop cannot launch the next participant."""
    db.set_room_run(conversation_id, None)
    with _lock:
        _runs.pop(conversation_id, None)


def stop_all():
    with _lock:
        ids = set(_runs)
    ids.update(cid for cid, _state in db.pending_room_runs())
    for conversation_id in ids:
        stop(conversation_id)


def stop_message(message_id):
    msg = db.get_message(message_id)
    if not msg:
        return
    state = db.get_room_run(msg["conversation_id"])
    if state and (state.get("message_id") == message_id or
                  (state.get("message_id") is None and _ensure_current_id(msg["conversation_id"], state) == message_id)):
        stop(msg["conversation_id"])


def recover():
    """Resume durable Room runs after db.init() marks interrupted streams stopped."""
    for conversation_id, state in db.pending_room_runs():
        try:
            turns = state["turns"]
            state["index"] = int(state["index"])
            if not turns or state["index"] < 0 or state["index"] >= len(turns):
                db.set_room_run(conversation_id, None)
                continue
            state["message_id"] = state.get("message_id") or _ensure_current_id(conversation_id, state)
            msg = db.get_message(state["message_id"]) if state["message_id"] else None
            if msg and msg["status"] == "stopped":
                text = msg["content"].strip()
                marker = "[Fala interrompida pelo reinício do CEU.]"
                db.update_message(msg["id"], status="error", error="Fala interrompida pelo reinício do CEU.",
                                  content=(text + "\n\n" + marker).strip())
            db.set_room_run(conversation_id, state)
            run = Run()
            with _lock:
                if conversation_id in _runs:
                    continue
                _runs[conversation_id] = run
            threading.Thread(target=_conduct, args=(run, conversation_id), daemon=True,
                             name=f"room-{conversation_id[:6]}").start()
        except (KeyError, TypeError, ValueError):
            db.set_room_run(conversation_id, None)
