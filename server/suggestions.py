"""Starter cards: three first messages written by a small model. Agents get theirs from their
name + instructions (regenerated when those change); the empty chat gets a set built from who
the user is and what they've been talking about, refreshed in the background when stale."""
import re
import threading
import time

from . import db, generation, providers

HOME_MAX_AGE = 6 * 3600       # refresh at least this often
HOME_MIN_AGE = 20 * 60        # but not more often than this, even when the history changed

_home_lock = threading.Lock()
_home_busy = False


def _language(settings=None):
    return "pt-BR" if (settings or db.get_settings()).get("language") == "pt-BR" else "en"


def _home_cache_key(settings=None):
    return "home_suggestions:" + _language(settings)


def _model(fallback):
    return generation._resolve_model(db.get_settings().get("suggestion_model") or fallback)


def _ask(model_ref, prompt):
    provider, model = _model(model_ref)
    text = providers.complete_short(provider, model, None, prompt, generation.Cancel(), limit=900)
    return parse(text)


def parse(text):
    """Model output -> up to 3 clean one-line suggestions (None if it didn't produce at least 2)."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    out = []
    for line in text.splitlines():
        line = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", line).strip().strip("\"'“”*`").strip()
        if 8 <= len(line) <= 140 and line not in out and not line.endswith(":"):
            out.append(line)
    return out[:3] if len(out) >= 2 else None


RULES = (
    "Responda com exatamente 3 linhas, uma sugestão por linha, sem numeração, sem aspas e sem markdown. "
    "Cada sugestão tem no máximo 90 caracteres e é escrita na voz do usuário, pronta para enviar."
)


# ---------------------------------------------------------------- agents

def refresh_agent(agent_id):
    threading.Thread(target=_agent_worker, args=(agent_id,), daemon=True).start()


def _agent_worker(agent_id):
    agent = db.get_agent(agent_id)
    if not agent:
        return
    prompt = (
        "Um usuário acabou de criar um agente de IA com memória própria, um computador isolado, acesso à web "
        "e tarefas em segundo plano (inclusive agendadas). Escreva 3 primeiras mensagens que o usuário "
        "mandaria para este agente, específicas ao propósito dele:\n"
        "1. uma que peça ao agente para se apresentar e perguntar sobre o contexto/objetivos do usuário nesse "
        "tema, no imperativo dirigido ao agente (ex.: \"Apresente-se e me pergunte...\");\n"
        "2. um pedido concreto e útil que ele pode resolver agora;\n"
        "3. uma tarefa recorrente com horário ou frequência, ligada ao propósito.\n"
        f"Use o idioma das instruções ({'português' if _language() == 'pt-BR' else 'inglês'} se não houver). {RULES}\n\n"
        f"<nome>{agent['name']}</nome>\n<instrucoes>{agent['instructions'][:3000] or '(sem instruções)'}</instrucoes>"
    )
    try:
        items = _ask(agent["model"] or db.get_settings().get("default_model"), prompt)
    except Exception:  # noqa: BLE001 - suggestions are best-effort
        import traceback
        traceback.print_exc()
        return
    if items and db.get_agent(agent_id):
        db.update_agent(agent_id, {"suggestions": items}, touch=False)
        generation.bus.publish({"type": "agent", "agent_id": agent_id})


# ---------------------------------------------------------------- empty chat

def _home_signature():
    return "|".join(c["id"] for c in db.list_conversations()[:8])


def home():
    """Cached cards for the empty chat; kicks off a refresh when they're stale."""
    settings = db.get_settings()
    cached = db.get_cache(_home_cache_key(settings)) or {}
    if not (settings.get("suggestion_model") or settings.get("default_model")):
        # First run uses the client's static cards until a model is configured.
        return cached.get("items") or []
    age = time.time() - cached.get("at", 0)
    if age > HOME_MAX_AGE or (age > HOME_MIN_AGE and cached.get("sig") != _home_signature()):
        _start_home()
    return cached.get("items") or []


def _start_home():
    global _home_busy
    with _home_lock:
        if _home_busy:
            return
        _home_busy = True
    threading.Thread(target=_home_worker, daemon=True).start()


def _home_worker():
    global _home_busy
    sig = _home_signature()
    items = None
    cache_key = None
    try:
        s = db.get_settings()
        cache_key = _home_cache_key(s)
        titles = [c["title"] for c in db.list_conversations()[:15] if c.get("title")]
        memories = [m["content"] for m in db.list_memories()][-20:] if s.get("memory_enabled") else []
        about = "\n".join(f"{k}: {s[k]}" for k in ("nickname", "occupation", "about") if (s.get(k) or "").strip())
        prompt = (
            "Escreva 3 mensagens curtas que este usuário provavelmente gostaria de mandar ao abrir uma conversa "
            "nova com um assistente de IA. Baseie-se no perfil, nas memórias e nos assuntos recentes: continue "
            "interesses reais, sem repetir literalmente conversas que já existem, e varie o tipo (uma pergunta, "
            "uma tarefa prática, uma ideia para explorar). Se não houver contexto, sugira usos úteis e variados. "
            f"Escreva em {'português' if _language(s) == 'pt-BR' else 'inglês'}. {RULES}\n\n"
            f"<perfil>{about[:1500] or '(vazio)'}</perfil>\n"
            f"<memorias>{chr(10).join(memories)[:2000] or '(nenhuma)'}</memorias>\n"
            f"<conversas_recentes>{chr(10).join(titles) or '(nenhuma)'}</conversas_recentes>"
        )
        items = _ask(s.get("default_model"), prompt)
    except Exception:  # noqa: BLE001
        import traceback
        traceback.print_exc()
    try:
        if items:
            db.set_cache(cache_key, {"items": items, "at": time.time(), "sig": sig})
            generation.bus.publish({"type": "suggestions"})
        elif cache_key:  # failed: keep the old cards, retry in HOME_MIN_AGE instead of on every request
            old = db.get_cache(cache_key) or {}
            db.set_cache(cache_key, {**old, "at": time.time() - HOME_MAX_AGE + HOME_MIN_AGE, "sig": sig})
    finally:
        with _home_lock:
            _home_busy = False
