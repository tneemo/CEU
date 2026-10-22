"""SQLite persistence. One connection per thread, WAL mode."""
import json
import os
import sqlite3
import threading
import time
import uuid

DATA_DIR = os.path.abspath(os.path.expanduser(os.environ.get("CEU_DATA_DIR") or
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")))
DB_PATH = os.path.join(DATA_DIR, "app.db")

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- 'anthropic' | 'openai' | 'codex'
  preset TEXT NOT NULL,          -- 'anthropic' | 'openai' | 'openrouter' | 'local' | 'custom' | 'codex'
  name TEXT NOT NULL,
  base_url TEXT,
  api_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  models TEXT NOT NULL DEFAULT '[]',
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  title_state TEXT NOT NULL DEFAULT 'pending',   -- pending | auto | manual
  model TEXT,
  effort TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  current_leaf_id TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  deleted_at REAL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  reasoning_ms INTEGER,
  attachments TEXT NOT NULL DEFAULT '[]',
  raw_blocks TEXT,
  model TEXT,
  provider_kind TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  error TEXT,
  notice TEXT,
  usage TEXT,
  created_at REAL NOT NULL,
  first_token_at REAL,
  finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS project_rules (
  project_path TEXT NOT NULL,
  tool TEXT NOT NULL,            -- 'run_command' | 'edit'
  pattern TEXT NOT NULL,         -- command prefix ('' = any) for run_command; '' for edit
  created_at REAL NOT NULL,
  PRIMARY KEY (project_path, tool, pattern)
);
CREATE TABLE IF NOT EXISTS checkpoints (
  turn_id TEXT NOT NULL,         -- the assistant message of the generation that made the edit
  path TEXT NOT NULL,            -- absolute path of the edited file
  before BLOB,                   -- content before the first edit of this turn; NULL = file didn't exist
  created_at REAL NOT NULL,
  PRIMARY KEY (turn_id, path)
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  model TEXT,
  effort TEXT,
  conversation_id TEXT,          -- the agent's own thread (kind='agent')
  host_folder TEXT,              -- optional folder of this computer the agent may use
  rules TEXT NOT NULL DEFAULT '{}',  -- action class -> allow | ask | block
  research_hours REAL NOT NULL DEFAULT 0,  -- proactive research interval (0 = off)
  paused INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  deleted_at REAL
);
CREATE TABLE IF NOT EXISTS agent_notes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',  -- agent | user | research
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,  -- the task's own thread (kind='agent_task')
  kind TEXT NOT NULL DEFAULT 'task',  -- task | research
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  schedule TEXT,                 -- JSON {"every_minutes": n} | {"daily_at": "HH:MM"} | NULL (runs once)
  status TEXT NOT NULL DEFAULT 'idle',  -- idle | running | waiting | blocked | done | error | stopped | paused
  next_run_at REAL,
  last_run_at REAL,
  last_result TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_log (  -- the agent's activity journal: what its work did, across runs
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  title TEXT NOT NULL DEFAULT '',  -- the task's title when it happened (survives the task)
  kind TEXT NOT NULL,            -- created | ran | continue | blocked | done | error | stopped | resumed
  text TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,      -- the parked assistant placeholder
  round_id TEXT NOT NULL,        -- the tool_result row of the parked round
  call_index INTEGER NOT NULL,   -- first call of the round still to run
  calls TEXT NOT NULL,           -- JSON: the round's tool calls
  request TEXT NOT NULL,         -- JSON: what the approval card shows
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | allow | always | deny | cancelled
  reason TEXT,
  created_at REAL NOT NULL,
  answered_at REAL
);
CREATE TABLE IF NOT EXISTS agent_calls (  -- work an agent asked of an executor (coordination.py)
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,                  -- the objective it served (NULL = asked from the main thread)
  origin_id TEXT NOT NULL,       -- the agent thread that placed the call
  role TEXT NOT NULL,            -- investigate | implement | review
  runtime TEXT NOT NULL,         -- code_runtimes id the executor ran on
  model TEXT,                    -- model ref (NULL = the harness's default model)
  label TEXT NOT NULL,           -- the executor as people and models read it
  request TEXT NOT NULL,
  conversation_id TEXT,          -- the Code session it ran in
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',  -- running | complete | error | stopped
  verdict TEXT,                  -- review: approved | changes | NULL (no verdict given)
  fingerprint TEXT,              -- review: the folder content it reviewed (coordination.fingerprint)
  result TEXT,
  created_at REAL NOT NULL,
  finished_at REAL
);
CREATE TABLE IF NOT EXISTS issues (  -- the open questions of an agent's work (coordination.py)
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,                  -- the objective it belongs to (NULL = the agent's own)
  kind TEXT NOT NULL,            -- problem | hypothesis | contradiction | question | lead | finding
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',  -- open | noted (a finding) | resolved | discarded
  resolution TEXT,
  raised_by TEXT NOT NULL,       -- who raised it: the agent, an executor's label, or 'user'
  call_id TEXT,                  -- the executor call whose report raised it
  closed_by TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at REAL NOT NULL
);
"""


def conn():
    c = getattr(_local, "conn", None)
    if c is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        c = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA synchronous=NORMAL")
        _local.conn = c
    return c


# Columns added after the first release: (table, column, definition).
MIGRATIONS = [
    ("conversations", "archived", "INTEGER NOT NULL DEFAULT 0"),
    ("conversations", "temporary", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "feedback", "INTEGER"),  # 1 = good, -1 = bad
    ("conversations", "kind", "TEXT NOT NULL DEFAULT 'chat'"),  # chat | code
    ("conversations", "project_path", "TEXT"),                  # code: the folder the session works in
    ("conversations", "permission_mode", "TEXT"),               # code: manual | accept_edits | plan | auto
    ("conversations", "agent_id", "TEXT"),                      # agent | agent_task: the agent it belongs to
    ("agents", "suggestions", "TEXT"),                          # JSON: starter cards written by the suggestion model
    ("conversations", "runtime", "TEXT"),                       # code: harness that runs it (code_runtimes; NULL = ceu)
    ("conversations", "runtime_session", "TEXT"),               # code, external harness: its session id, resumed each turn
    ("agent_tasks", "progress", "TEXT"),                        # the agent's own record of where the work stands
    ("agent_tasks", "outcome", "TEXT"),                         # JSON: how the current/last run ended (agent_mode)
    ("agent_tasks", "streak", "INTEGER NOT NULL DEFAULT 0"),    # continuations in a row without the user stepping in
    ("messages", "call", "TEXT"),                               # JSON: a turn asked of a named target (calls.py)
    ("conversations", "origin", "TEXT"),    # JSON: the conversation + message a delegated call came from (delegate.py)
    ("conversations", "room", "TEXT"),      # JSON: a Room's participants, order and rounds (rooms.py)
    ("conversations", "room_run", "TEXT"),  # JSON: durable Room sequence progress (rooms.py)
    ("agent_tasks", "baseline", "TEXT"),    # JSON: where the granted folder stood when the objective began (coordination.py)
]


def _migrate():
    c = conn()
    for table, col, ddl in MIGRATIONS:
        cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def init():
    conn().executescript(SCHEMA)
    _migrate()
    # Temporary conversations never outlive the server session that created them.
    for r in conn().execute("SELECT id FROM conversations WHERE temporary=1").fetchall():
        _hard_delete(r["id"])
    # Messages left mid-stream by a crash/restart can't resume: mark them stopped.
    conn().execute(
        "UPDATE messages SET status='stopped', finished_at=? WHERE status='streaming'", (time.time(),)
    )
    # Agent tasks that were running died with the process: they pick up again from their recorded
    # progress shortly after boot (agent_mode.run_task counts it as a continuation). Parked ones
    # ('waiting') survive: their state is in agent_approvals and resumes when the user answers.
    for r in conn().execute("SELECT id, agent_id, title FROM agent_tasks WHERE status='running'").fetchall():
        conn().execute("UPDATE agent_tasks SET status='idle', next_run_at=?, outcome=? WHERE id=?",
                       (time.time() + 60, json.dumps({"state": "continue", "why": "restart"}), r["id"]))
        add_log(r["agent_id"], r["id"], r["title"], "resumed", "Interrompida quando o CEU fechou; retoma em instantes.")
    # An executor call dies with the turn that waited for it; its Code session keeps what it did.
    conn().execute("UPDATE agent_calls SET status='stopped', finished_at=? WHERE status='running'", (time.time(),))
    purge_deleted(0)


def new_id():
    return uuid.uuid4().hex


def now():
    return time.time()


# ---------- settings ----------

DEFAULT_SETTINGS = {
    # geral
    "language": "en",             # en (default) | pt-BR; legacy auto resolves to English
    "send_key": "enter",          # enter | ctrl-enter
    "default_model": None,        # "providerId::modelId"
    "title_model": None,          # None = same as conversation
    "suggestion_model": None,     # starter cards (agents, empty chat); None = the agent's / default model
    "temporary_default": False,
    # aparência
    "theme": "system",            # system | dark | light
    "accent": "default",          # default | blue | green | yellow | pink | orange | purple | white
    "chat_font": "sans",          # sans | serif | mono | system
    "font_size": 15,
    "code_font_size": 13,
    "width": "medium",            # narrow | medium | wide
    "motion": "system",           # system | reduce | full
    "ambient": True,
    # personalização (composes the system prompt, see generation.system_prompt)
    "instructions": "",
    "nickname": "",
    "occupation": "",
    "about": "",
    "style": "default",           # default | professional | friendly | candid | quirky | efficient | cynical
    "warmth": "default",          # more | default | less
    "enthusiasm": "default",
    "headers_lists": "default",
    "emoji": "default",
    # memória
    "memory_enabled": True,
    "memory_chat_history": False,  # mock: consulting past conversations isn't implemented
    # notificações
    "notify_done": False,
    "notify_sound": False,
    # voz (Web Speech API, client side)
    "voice_name": "",             # "" = system default
    "voice_rate": 1.0,
    # recursos
    "tool_code": True,            # run_code
    "tool_files": True,           # read/write/list files in the conversation folder
    "sandbox_network": True,      # mock: the WSL sandbox doesn't block network yet
    # code runtimes
    "claude_sdk_provider": None,  # Anthropic provider whose API key the Claude SDK runtime uses (integrations.py)
    # lista de conversas
    "sidebar_sort": "updated",    # updated | created
    "sidebar_group": "date",      # date | none
}


def get_settings():
    out = dict(DEFAULT_SETTINGS)
    for row in conn().execute("SELECT key, value FROM settings"):
        try:
            out[row["key"]] = json.loads(row["value"])
        except ValueError:
            pass
    return out


def update_settings(patch):
    c = conn()
    for k, v in patch.items():
        if k in DEFAULT_SETTINGS:
            c.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, json.dumps(v)),
            )
    return get_settings()


# ---------- cache (derived data that's cheap to lose) ----------

def get_cache(key):
    row = conn().execute("SELECT value FROM cache WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else None


def set_cache(key, value):
    conn().execute("INSERT INTO cache(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(value)))


# ---------- providers ----------

def _provider_row(row, reveal=False):
    d = dict(row)
    d["enabled"] = bool(d["enabled"])
    d["models"] = json.loads(d["models"] or "[]")
    key = d.pop("api_key") or ""
    if reveal:
        d["api_key"] = key
    else:
        d["has_key"] = bool(key)
        d["key_hint"] = ("…" + key[-4:]) if len(key) > 8 else ""
    return d


def list_providers(reveal=False):
    return [_provider_row(r, reveal) for r in conn().execute("SELECT * FROM providers ORDER BY created_at")]


def get_provider(pid, reveal=True):
    row = conn().execute("SELECT * FROM providers WHERE id=?", (pid,)).fetchone()
    return _provider_row(row, reveal) if row else None


def create_provider(kind, preset, name, base_url, api_key, models=None):
    pid = new_id()[:12]
    conn().execute(
        "INSERT INTO providers(id, kind, preset, name, base_url, api_key, models, created_at) VALUES(?,?,?,?,?,?,?,?)",
        (pid, kind, preset, name, base_url, api_key, json.dumps(models or []), now()),
    )
    return get_provider(pid, reveal=False)


def update_provider(pid, patch):
    fields = []
    values = []
    for k in ("name", "base_url", "api_key", "enabled", "models"):
        if k in patch:
            v = patch[k]
            if k == "models":
                v = json.dumps(v)
            if k == "enabled":
                v = 1 if v else 0
            fields.append(f"{k}=?")
            values.append(v)
    if fields:
        values.append(pid)
        conn().execute(f"UPDATE providers SET {', '.join(fields)} WHERE id=?", values)
    return get_provider(pid, reveal=False)


def delete_provider(pid):
    conn().execute("DELETE FROM providers WHERE id=?", (pid,))


# ---------- conversations ----------

def _conv_row(row):
    d = dict(row)
    d.pop("room_run", None)  # internal conductor state; read through get_room_run()
    d["pinned"] = bool(d["pinned"])
    d["archived"] = bool(d.get("archived"))
    d["temporary"] = bool(d.get("temporary"))
    for k in ("origin", "room"):
        d[k] = json.loads(d[k]) if d.get(k) else None
    return d


def list_conversations(archived=False):
    rows = conn().execute(
        """SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count
           FROM conversations c WHERE c.deleted_at IS NULL AND c.temporary=0 AND c.archived=?
             AND c.kind IN ('chat', 'code')
           ORDER BY c.updated_at DESC""", (1 if archived else 0,)
    ).fetchall()
    return [_conv_row(r) for r in rows]


def archive_all():
    conn().execute("UPDATE conversations SET archived=1, pinned=0 WHERE deleted_at IS NULL AND temporary=0 "
                   "AND kind IN ('chat', 'code')")


def get_conversation(cid, include_deleted=False):
    row = conn().execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
    if not row or (row["deleted_at"] and not include_deleted):
        return None
    return _conv_row(row)


def get_room_run(cid):
    row = conn().execute("SELECT room_run FROM conversations WHERE id=?", (cid,)).fetchone()
    return json.loads(row["room_run"]) if row and row["room_run"] else None


def set_room_run(cid, state):
    conn().execute("UPDATE conversations SET room_run=?, updated_at=? WHERE id=?",
                   (json.dumps(state) if state else None, now(), cid))


def pending_room_runs():
    rows = conn().execute("SELECT id, room_run FROM conversations WHERE room IS NOT NULL AND room_run IS NOT NULL "
                          "AND deleted_at IS NULL").fetchall()
    return [(r["id"], json.loads(r["room_run"])) for r in rows]


PERMISSION_MODES = ("manual", "accept_edits", "plan", "auto")


def create_conversation(model=None, effort=None, temporary=False, kind="chat", project_path=None, permission_mode=None,
                        agent_id=None, title="", runtime=None, origin=None, room=None):
    cid = new_id()
    t = now()
    if kind == "code" and permission_mode not in PERMISSION_MODES:
        permission_mode = "manual"
    conn().execute(
        """INSERT INTO conversations(id, model, effort, temporary, kind, project_path, permission_mode, agent_id, title,
                                     title_state, runtime, origin, room, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (cid, model, effort, 1 if temporary else 0, kind, project_path, permission_mode, agent_id, title,
         "manual" if title else "pending", runtime, json.dumps(origin) if origin else None,
         json.dumps(room) if room else None, t, t),
    )
    return get_conversation(cid)


def delegated_session(origin_id, project_path):
    """The Code session a conversation's `@Code` calls on this folder run in (delegate.py), if any."""
    row = conn().execute(
        """SELECT * FROM conversations WHERE kind='code' AND deleted_at IS NULL AND project_path=?
             AND json_extract(origin, '$.conversation_id')=? ORDER BY updated_at DESC LIMIT 1""",
        (project_path, origin_id)).fetchone()
    return _conv_row(row) if row else None


def recent_projects(limit=12):
    rows = conn().execute(
        """SELECT project_path, MAX(updated_at) AS used_at, COUNT(*) AS sessions FROM conversations
           WHERE kind='code' AND project_path IS NOT NULL AND deleted_at IS NULL
           GROUP BY project_path ORDER BY used_at DESC LIMIT ?""", (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---------- code mode: approval rules and edit checkpoints ----------

def list_rules(project_path):
    return [dict(r) for r in conn().execute(
        "SELECT tool, pattern FROM project_rules WHERE project_path=? ORDER BY created_at", (project_path,))]


def add_rule(project_path, tool, pattern):
    conn().execute("INSERT OR IGNORE INTO project_rules(project_path, tool, pattern, created_at) VALUES(?,?,?,?)",
                   (project_path, tool, pattern, now()))


def delete_rule(project_path, tool, pattern):
    conn().execute("DELETE FROM project_rules WHERE project_path=? AND tool=? AND pattern=?", (project_path, tool, pattern))


def save_checkpoint(turn_id, path, before):
    """Keeps only the first snapshot per (turn, file): that's the state 'Desfazer' restores."""
    conn().execute("INSERT OR IGNORE INTO checkpoints(turn_id, path, before, created_at) VALUES(?,?,?,?)",
                   (turn_id, path, sqlite3.Binary(before) if before is not None else None, now()))


def list_checkpoints(turn_id):
    return [dict(r) for r in conn().execute("SELECT path, before FROM checkpoints WHERE turn_id=?", (turn_id,))]


def turns_with_checkpoints(turn_ids):
    if not turn_ids:
        return set()
    q = ",".join("?" * len(turn_ids))
    return {r["turn_id"] for r in conn().execute(f"SELECT DISTINCT turn_id FROM checkpoints WHERE turn_id IN ({q})", turn_ids)}


def delete_checkpoints(turn_id):
    conn().execute("DELETE FROM checkpoints WHERE turn_id=?", (turn_id,))


def update_conversation(cid, patch, touch=False):
    fields, values = [], []
    for k in ("title", "title_state", "model", "effort", "pinned", "archived", "current_leaf_id", "deleted_at",
              "permission_mode", "runtime_session", "origin", "room"):
        if k in patch:
            v = patch[k]
            if k in ("pinned", "archived"):
                v = 1 if v else 0
            elif k in ("origin", "room"):
                v = json.dumps(v) if v else None
            fields.append(f"{k}=?")
            values.append(v)
    if touch:
        fields.append("updated_at=?")
        values.append(now())
    if fields:
        values.append(cid)
        conn().execute(f"UPDATE conversations SET {', '.join(fields)} WHERE id=?", values)
    return get_conversation(cid, include_deleted=True)


def purge_deleted(older_than_seconds=60):
    c = conn()
    cutoff = now() - older_than_seconds
    ids = [r["id"] for r in c.execute("SELECT id FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))]
    for cid in ids:
        _hard_delete(cid)
    # attachments no longer referenced by any message and older than a day
    refs = set()
    for r in c.execute("SELECT attachments FROM messages WHERE attachments != '[]'"):
        for a in json.loads(r["attachments"]):
            refs.add(a.get("id"))
    for r in c.execute("SELECT id FROM attachments WHERE created_at < ?", (now() - 86400,)):
        if r["id"] not in refs:
            c.execute("DELETE FROM attachments WHERE id=?", (r["id"],))


def _hard_delete(cid):
    c = conn()
    c.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
    c.execute("DELETE FROM conversations WHERE id=?", (cid,))


def delete_conversation_now(cid):
    _hard_delete(cid)


def delete_archived():
    for r in conn().execute("SELECT id FROM conversations WHERE archived=1").fetchall():
        _hard_delete(r["id"])


def delete_all_conversations():
    c = conn()
    c.execute("DELETE FROM messages")
    c.execute("DELETE FROM conversations")
    c.execute("DELETE FROM attachments")
    # agents are built on their conversations: without them nothing of the agent is usable
    for table in ("agents", "agent_notes", "agent_tasks", "agent_approvals", "agent_log"):
        c.execute(f"DELETE FROM {table}")


# ---------- messages ----------

def _msg_row(row):
    d = dict(row)
    d["attachments"] = json.loads(d["attachments"] or "[]")
    d["usage"] = json.loads(d["usage"]) if d["usage"] else None
    raw = d.pop("raw_blocks", None)
    d["call"] = json.loads(d["call"]) if d.get("call") else None
    # Tool rounds expose their structured calls/results (never the provider-native blocks).
    if d["role"] == "tool_call" and raw:
        d["tool_calls"] = (json.loads(raw) or {}).get("tool_calls") or []
    elif d["role"] == "tool_result" and raw:
        d["tool_results"] = (json.loads(raw) or {}).get("tool_results") or []
    elif d["role"] == "assistant" and raw:
        data = json.loads(raw)
        if isinstance(data, dict) and data.get("redir"):
            d["model_run"] = data["redir"]
    return d


def list_messages(cid):
    return [_msg_row(r) for r in conn().execute(
        "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,))]


def get_message(mid, raw=False):
    row = conn().execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
    if not row:
        return None
    if raw:
        d = dict(row)
        d["attachments"] = json.loads(d["attachments"] or "[]")
        d["raw_blocks"] = json.loads(d["raw_blocks"]) if d["raw_blocks"] else None
        d["call"] = json.loads(d["call"]) if d.get("call") else None
        return d
    return _msg_row(row)


def create_message(cid, parent_id, role, content="", attachments=None, model=None, provider_kind=None, status="complete",
                   call=None):
    mid = new_id()
    conn().execute(
        """INSERT INTO messages(id, conversation_id, parent_id, role, content, attachments, model, provider_kind, status,
                                created_at, call)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (mid, cid, parent_id, role, content, json.dumps(attachments or []), model, provider_kind, status, now(),
         json.dumps(call) if call else None),
    )
    return get_message(mid)


def update_message(mid, **patch):
    fields, values = [], []
    for k, v in patch.items():
        if k in ("usage", "raw_blocks", "call") and v is not None:
            v = json.dumps(v)
        fields.append(f"{k}=?")
        values.append(v)
    if fields:
        values.append(mid)
        conn().execute(f"UPDATE messages SET {', '.join(fields)} WHERE id=?", values)


def path_to(mid):
    """Messages from root to `mid` (inclusive), in order."""
    out = []
    seen = set()
    while mid and mid not in seen:
        seen.add(mid)
        m = get_message(mid, raw=True)
        if not m:
            break
        out.append(m)
        mid = m["parent_id"]
    out.reverse()
    return out


def search(q, limit=30):
    like = "%" + q.replace("%", r"\%").replace("_", r"\_") + "%"
    c = conn()
    results = []
    seen = set()
    for r in c.execute(
        r"""SELECT id, title, updated_at FROM conversations
           WHERE deleted_at IS NULL AND temporary=0 AND title LIKE ? ESCAPE '\' ORDER BY updated_at DESC LIMIT ?""",
        (like, limit),
    ):
        seen.add(r["id"])
        results.append({"conversation_id": r["id"], "title": r["title"], "updated_at": r["updated_at"], "snippet": None, "message_id": None})
    for r in c.execute(
        r"""SELECT m.id, m.conversation_id, m.content, c.title, c.updated_at FROM messages m
           JOIN conversations c ON c.id=m.conversation_id
           WHERE c.deleted_at IS NULL AND c.temporary=0 AND m.content LIKE ? ESCAPE '\'
           ORDER BY m.created_at DESC LIMIT ?""",
        (like, limit * 3),
    ):
        if r["conversation_id"] in seen:
            continue
        seen.add(r["conversation_id"])
        text = r["content"]
        i = text.lower().find(q.lower())
        start = max(0, i - 50)
        snippet = ("…" if start else "") + text[start:i + len(q) + 90].replace("\n", " ")
        results.append({"conversation_id": r["conversation_id"], "title": r["title"], "updated_at": r["updated_at"],
                        "snippet": snippet, "message_id": r["id"]})
        if len(results) >= limit:
            break
    return results


# ---------- attachments ----------

def save_attachment(name, mime, data):
    aid = new_id()
    conn().execute(
        "INSERT INTO attachments(id, name, mime, size, data, created_at) VALUES(?,?,?,?,?,?)",
        (aid, name, mime, len(data), sqlite3.Binary(data), now()),
    )
    return {"id": aid, "name": name, "mime": mime, "size": len(data)}


def get_attachment(aid):
    row = conn().execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
    return dict(row) if row else None


# ---------- memories ----------

def list_memories():
    return [dict(r) for r in conn().execute("SELECT * FROM memories ORDER BY created_at")]


def _memory(mid):
    row = conn().execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
    return dict(row) if row else None


def create_memory(content):
    mid = new_id()[:12]
    t = now()
    conn().execute("INSERT INTO memories(id, content, created_at, updated_at) VALUES(?,?,?,?)", (mid, content, t, t))
    return _memory(mid)


def update_memory(mid, content):
    conn().execute("UPDATE memories SET content=?, updated_at=? WHERE id=?", (content, now(), mid))
    return _memory(mid)


def delete_memory(mid):
    conn().execute("DELETE FROM memories WHERE id=?", (mid,))


def delete_all_memories():
    conn().execute("DELETE FROM memories")


# ---------- feedback & branching ----------

def set_feedback(mid, value):
    conn().execute("UPDATE messages SET feedback=? WHERE id=?", (value, mid))


def branch_conversation(mid):
    """A new conversation holding a copy of the path root → `mid`."""
    path = path_to(mid)
    if not path:
        return None
    src = get_conversation(path[0]["conversation_id"], include_deleted=True)
    # An external harness's session is not copied: the branch starts a fresh one.
    conv = create_conversation(src["model"], src["effort"], kind=src.get("kind") or "chat",
                               project_path=src.get("project_path"), permission_mode=src.get("permission_mode"),
                               runtime=src.get("runtime"), room=src.get("room"))
    cols = ("role", "content", "reasoning", "reasoning_ms", "model", "provider_kind", "status", "error", "notice",
            "usage", "created_at", "first_token_at", "finished_at")
    parent = None
    for m in path:
        new = new_id()
        conn().execute(
            f"""INSERT INTO messages(id, conversation_id, parent_id, attachments, raw_blocks, call, {', '.join(cols)})
                VALUES(?,?,?,?,?,?,{','.join('?' * len(cols))})""",
            (new, conv["id"], parent, json.dumps(m["attachments"]),
             json.dumps(m["raw_blocks"]) if m.get("raw_blocks") is not None else None,
             json.dumps(m["call"]) if m.get("call") else None,
             *(m.get(c) for c in cols)),
        )
        parent = new
    title = ((src["title"] or "Conversa") + " (ramificação)")[:120]
    return update_conversation(conv["id"], {"title": title, "title_state": "manual", "current_leaf_id": parent}, touch=True)


# ---------- usage, storage, export ----------

def usage(days=30):
    """Totals, per-model and per-day aggregates. Token counts are what each provider reported."""
    c = conn()
    since = now() - days * 86400
    totals = dict(c.execute(
        """SELECT (SELECT COUNT(*) FROM conversations WHERE deleted_at IS NULL AND temporary=0) AS conversations,
                  (SELECT COUNT(*) FROM messages WHERE role='user') AS prompts,
                  (SELECT COUNT(*) FROM messages WHERE role='assistant') AS responses""").fetchone())
    by_model, by_day = {}, {}
    tin = tout = 0
    for r in c.execute("SELECT model, usage, created_at FROM messages WHERE role='assistant' AND usage IS NOT NULL"):
        try:
            u = json.loads(r["usage"]) or {}
        except ValueError:
            continue
        i, o = int(u.get("input") or 0), int(u.get("output") or 0)
        tin += i
        tout += o
        # local servers report a file path as the model id: keep just the file name
        key = (r["model"] or "?").split("::")[-1].replace("\\", "/").rsplit("/", 1)[-1]
        m = by_model.setdefault(key, {"model": key, "responses": 0, "input": 0, "output": 0})
        m["responses"] += 1
        m["input"] += i
        m["output"] += o
        if r["created_at"] >= since:
            day = time.strftime("%Y-%m-%d", time.localtime(r["created_at"]))
            d = by_day.setdefault(day, {"day": day, "responses": 0, "output": 0})
            d["responses"] += 1
            d["output"] += o
    totals.update({"input_tokens": tin, "output_tokens": tout})
    return {"totals": totals, "by_model": sorted(by_model.values(), key=lambda x: -x["output"]),
            "by_day": [by_day[k] for k in sorted(by_day)], "days": days}


def storage():
    c = conn()
    att = c.execute("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM attachments").fetchone()
    db_bytes = sum(os.path.getsize(DB_PATH + suf) for suf in ("", "-wal") if os.path.exists(DB_PATH + suf))
    ws_bytes = ws_files = 0
    for root, _dirs, files in os.walk(os.path.join(DATA_DIR, "workspaces")):
        for f in files:
            try:
                ws_bytes += os.path.getsize(os.path.join(root, f))
                ws_files += 1
            except OSError:
                pass
    archived = c.execute("SELECT COUNT(*) FROM conversations WHERE archived=1 AND deleted_at IS NULL").fetchone()[0]
    return {"database": db_bytes, "attachments": {"count": att["n"], "bytes": att["bytes"]},
            "workspaces": {"count": ws_files, "bytes": ws_bytes}, "archived": archived}


def export_all():
    convs = []
    for row in conn().execute("SELECT * FROM conversations WHERE deleted_at IS NULL AND temporary=0 ORDER BY created_at"):
        d = _conv_row(row)
        d["messages"] = list_messages(d["id"])
        convs.append(d)
    agents = []
    for a in list_agents():
        a["notes"] = list_notes(a["id"])
        a["tasks"] = list_tasks(a["id"])
        agents.append(a)
    return {"app": "CEU", "exported_at": now(), "settings": get_settings(), "memories": list_memories(),
            "conversations": convs, "agents": agents}


# ---------- agents ----------

def _agent_row(row):
    d = dict(row)
    d["rules"] = json.loads(d["rules"] or "{}")
    d["paused"] = bool(d["paused"])
    d["suggestions"] = json.loads(d.get("suggestions") or "[]")
    return d


def list_agents():
    return [_agent_row(r) for r in conn().execute("SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY created_at")]


def get_agent(aid):
    row = conn().execute("SELECT * FROM agents WHERE id=? AND deleted_at IS NULL", (aid,)).fetchone()
    return _agent_row(row) if row else None


def create_agent(name, instructions, model, effort, host_folder, rules):
    aid = new_id()[:12]
    t = now()
    conv = create_conversation(model, effort, kind="agent", agent_id=aid, title=name)
    conn().execute(
        """INSERT INTO agents(id, name, instructions, model, effort, conversation_id, host_folder, rules, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (aid, name, instructions, model, effort, conv["id"], host_folder, json.dumps(rules), t, t))
    return get_agent(aid)


def update_agent(aid, patch, touch=True):
    fields, values = [], []
    for k in ("name", "instructions", "model", "effort", "host_folder", "rules", "research_hours", "paused",
              "suggestions"):
        if k in patch:
            v = patch[k]
            if k in ("rules", "suggestions"):
                v = json.dumps(v)
            elif k == "paused":
                v = 1 if v else 0
            fields.append(f"{k}=?")
            values.append(v)
    if fields:
        if touch:
            fields.append("updated_at=?")
            values.append(now())
        values.append(aid)
        conn().execute(f"UPDATE agents SET {', '.join(fields)} WHERE id=?", values)
    return get_agent(aid)


def delete_agent(aid):
    t = now()
    c = conn()
    c.execute("UPDATE agents SET deleted_at=? WHERE id=?", (t, aid))
    c.execute("UPDATE conversations SET deleted_at=? WHERE agent_id=?", (t, aid))
    c.execute("UPDATE agent_approvals SET status='cancelled' WHERE agent_id=? AND status='pending'", (aid,))
    for table in ("agent_notes", "agent_tasks", "agent_log", "agent_calls", "issues"):
        c.execute(f"DELETE FROM {table} WHERE agent_id=?", (aid,))


def list_notes(agent_id):
    return [dict(r) for r in conn().execute(
        "SELECT * FROM agent_notes WHERE agent_id=? ORDER BY created_at", (agent_id,))]


def get_note(nid):
    row = conn().execute("SELECT * FROM agent_notes WHERE id=?", (nid,)).fetchone()
    return dict(row) if row else None


def create_note(agent_id, content, source="agent"):
    nid = new_id()[:10]
    t = now()
    conn().execute("INSERT INTO agent_notes(id, agent_id, content, source, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                   (nid, agent_id, content, source, t, t))
    return get_note(nid)


def update_note(nid, content):
    conn().execute("UPDATE agent_notes SET content=?, updated_at=? WHERE id=?", (content, now(), nid))
    return get_note(nid)


def delete_note(nid):
    conn().execute("DELETE FROM agent_notes WHERE id=?", (nid,))


def _task_row(row):
    d = dict(row)
    d["schedule"] = json.loads(d["schedule"]) if d["schedule"] else None
    d["outcome"] = json.loads(d["outcome"]) if d.get("outcome") else None
    d["baseline"] = json.loads(d["baseline"]) if d.get("baseline") else None
    return d


def list_tasks(agent_id):
    return [_task_row(r) for r in conn().execute(
        "SELECT * FROM agent_tasks WHERE agent_id=? ORDER BY created_at", (agent_id,))]


def get_task(tid):
    row = conn().execute("SELECT * FROM agent_tasks WHERE id=?", (tid,)).fetchone()
    return _task_row(row) if row else None


def task_for_conversation(cid):
    row = conn().execute("SELECT * FROM agent_tasks WHERE conversation_id=?", (cid,)).fetchone()
    return _task_row(row) if row else None


def create_task(agent_id, conversation_id, kind, title, instructions, schedule, next_run_at):
    tid = new_id()[:12]
    t = now()
    conn().execute(
        """INSERT INTO agent_tasks(id, agent_id, conversation_id, kind, title, instructions, schedule, next_run_at,
                                   created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (tid, agent_id, conversation_id, kind, title, instructions, json.dumps(schedule) if schedule else None,
         next_run_at, t, t))
    return get_task(tid)


def update_task(tid, patch):
    fields, values = [], []
    for k in ("title", "instructions", "schedule", "status", "next_run_at", "last_run_at", "last_result", "runs",
              "progress", "outcome", "streak", "baseline"):
        if k in patch:
            v = patch[k]
            if k in ("schedule", "outcome", "baseline"):
                v = json.dumps(v) if v else None
            fields.append(f"{k}=?")
            values.append(v)
    if fields:
        fields.append("updated_at=?")
        values += [now(), tid]
        conn().execute(f"UPDATE agent_tasks SET {', '.join(fields)} WHERE id=?", values)
    return get_task(tid)


def delete_task(tid):
    task = get_task(tid)
    if not task:
        return
    conn().execute("DELETE FROM agent_tasks WHERE id=?", (tid,))
    conn().execute("DELETE FROM issues WHERE task_id=?", (tid,))
    conn().execute("DELETE FROM agent_calls WHERE task_id=?", (tid,))
    conn().execute("UPDATE conversations SET deleted_at=? WHERE id=?", (now(), task["conversation_id"]))
    conn().execute("UPDATE agent_approvals SET status='cancelled' WHERE conversation_id=? AND status='pending'",
                   (task["conversation_id"],))


def due_tasks(at):
    return [_task_row(r) for r in conn().execute(
        """SELECT t.* FROM agent_tasks t JOIN agents a ON a.id=t.agent_id
           WHERE a.deleted_at IS NULL AND a.paused=0 AND t.next_run_at IS NOT NULL AND t.next_run_at <= ?
             AND t.status NOT IN ('running', 'waiting', 'blocked', 'done', 'paused')
           ORDER BY t.next_run_at""", (at,))]


LOG_KEEP = 400  # journal entries kept per agent


def add_log(agent_id, task_id, title, kind, text=""):
    c = conn()
    c.execute("INSERT INTO agent_log(id, agent_id, task_id, title, kind, text, created_at) VALUES(?,?,?,?,?,?,?)",
              (new_id()[:12], agent_id, task_id, title or "", kind, (text or "")[:1500], now()))
    c.execute("DELETE FROM agent_log WHERE agent_id=? AND id NOT IN "
              "(SELECT id FROM agent_log WHERE agent_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
              (agent_id, agent_id, LOG_KEEP))


def list_log(agent_id, task_id=None, limit=30):
    """Newest first."""
    q, args = "SELECT * FROM agent_log WHERE agent_id=?", [agent_id]
    if task_id:
        q += " AND task_id=?"
        args.append(task_id)
    return [dict(r) for r in conn().execute(q + " ORDER BY created_at DESC, rowid DESC LIMIT ?", args + [limit])]


def _approval_row(row):
    d = dict(row)
    d["calls"] = json.loads(d["calls"])
    d["request"] = json.loads(d["request"])
    return d


def create_approval(agent_id, conversation_id, message_id, round_id, call_index, calls, request):
    aid = new_id()[:12]
    request = dict(request, approval_id=aid)
    conn().execute(
        """INSERT INTO agent_approvals(id, agent_id, conversation_id, message_id, round_id, call_index, calls, request,
                                       created_at) VALUES(?,?,?,?,?,?,?,?,?)""",
        (aid, agent_id, conversation_id, message_id, round_id, call_index, json.dumps(calls), json.dumps(request), now()))
    return get_approval(aid)


def get_approval(aid):
    row = conn().execute("SELECT * FROM agent_approvals WHERE id=?", (aid,)).fetchone()
    return _approval_row(row) if row else None


def pending_approvals(agent_id=None, conversation_id=None):
    q, args = "SELECT * FROM agent_approvals WHERE status='pending'", []
    if agent_id:
        q += " AND agent_id=?"
        args.append(agent_id)
    if conversation_id:
        q += " AND conversation_id=?"
        args.append(conversation_id)
    return [_approval_row(r) for r in conn().execute(q + " ORDER BY created_at", args)]


def answer_approval(aid, status, reason=""):
    """Atomically moves a pending approval to its answer; False if it was no longer pending."""
    cur = conn().execute("UPDATE agent_approvals SET status=?, reason=?, answered_at=? WHERE id=? AND status='pending'",
                         (status, reason, now(), aid))
    return cur.rowcount == 1


# ---------- coordination: executor calls and issues (coordination.py) ----------

def create_call(agent_id, task_id, origin_id, role, runtime, model, label, request):
    cid = new_id()[:12]
    conn().execute(
        """INSERT INTO agent_calls(id, agent_id, task_id, origin_id, role, runtime, model, label, request, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (cid, agent_id, task_id, origin_id, role, runtime, model, label, request, now()))
    return get_call(cid)


def get_call(cid):
    row = conn().execute("SELECT * FROM agent_calls WHERE id=?", (cid,)).fetchone()
    return dict(row) if row else None


def update_call(cid, patch):
    fields, values = [], []
    for k in ("conversation_id", "message_id", "status", "verdict", "fingerprint", "result", "finished_at"):
        if k in patch:
            fields.append(f"{k}=?")
            values.append(patch[k])
    if fields:
        values.append(cid)
        conn().execute(f"UPDATE agent_calls SET {', '.join(fields)} WHERE id=?", values)
    return get_call(cid)


def list_calls(agent_id, task_id=None):
    """Oldest first."""
    q, args = "SELECT * FROM agent_calls WHERE agent_id=?", [agent_id]
    if task_id:
        q += " AND task_id=?"
        args.append(task_id)
    return [dict(r) for r in conn().execute(q + " ORDER BY created_at, rowid", args)]


def create_issue(agent_id, task_id, kind, title, detail, raised_by, call_id=None, status="open"):
    iid = new_id()[:8]
    t = now()
    conn().execute(
        """INSERT INTO issues(id, agent_id, task_id, kind, title, detail, status, raised_by, call_id, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (iid, agent_id, task_id, kind, title, detail or "", status, raised_by, call_id, t, t))
    return get_issue(iid)


def get_issue(iid):
    row = conn().execute("SELECT * FROM issues WHERE id=?", (iid,)).fetchone()
    return dict(row) if row else None


def update_issue(iid, patch):
    fields, values = [], []
    for k in ("kind", "title", "detail", "status", "resolution", "closed_by"):
        if k in patch:
            fields.append(f"{k}=?")
            values.append(patch[k])
    if fields:
        fields.append("updated_at=?")
        values += [now(), iid]
        conn().execute(f"UPDATE issues SET {', '.join(fields)} WHERE id=?", values)
    return get_issue(iid)


def list_issues(agent_id, task_id=None):
    """Oldest first. `task_id`: only that objective's issues."""
    q, args = "SELECT * FROM issues WHERE agent_id=?", [agent_id]
    if task_id:
        q += " AND task_id=?"
        args.append(task_id)
    return [dict(r) for r in conn().execute(q + " ORDER BY created_at, rowid", args)]
