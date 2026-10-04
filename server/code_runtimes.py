"""Runtimes of the Code mode: which harness runs a code session's turns.

The harness is orthogonal to the model. The same provider/model can run under CEU's own
loop or under the vendor's official harness, so sessions can be compared side by side.

  ceu         CEU SDK     CEU's own loop (generation.py + code_tools): any provider, CEU's
                          tools, approvals, undo and steering.
  codex_sdk   Codex SDK   OpenAI's Codex harness driven natively over the app-server (codex_sdk.py),
                          its approval requests answered on CEU's approval card.
  claude_sdk  Claude SDK  Anthropic's Claude Agent SDK (claude_sdk.py), its permission callback
                          answered on CEU's approval card.
  redir:<id>  CEU REDIR   an external agent CLI run and supervised by CEU (redir.py).

Whether a runtime can start a session depends on its integration (integrations.py: installed,
logged in). A session's runtime is fixed when it is created (conversations.runtime; NULL = ceu).
"""
from . import integrations, redir

DEFAULT = "ceu"
ALL_MODES = ("manual", "accept_edits", "plan", "auto")

FAMILIES = {
    "ceu_sdk": "CEU SDK",
    "codex_sdk": "Codex SDK",
    "claude_sdk": "Claude SDK",
    "redir": "CEU REDIR",
}


def _integration_status(integ_id, ready_detail, probe=True):
    """(status, detail, integration summary) from the integration's lifecycle state."""
    snap = integrations.get(integ_id) if probe else integrations.cached(integ_id)
    if not snap:
        return "unavailable", "Ainda não verificado", {"id": integ_id, "state": "unknown",
                                                         "detail": "Ainda não verificado"}
    summary = {"id": snap["id"], "state": snap["state"], "detail": snap["detail"]}
    if snap["state"] == integrations.CONNECTED:
        return "ready", ready_detail, summary
    return "unavailable", snap["detail"], summary


def _ceu():
    return {"id": "ceu", "family": "ceu_sdk", "name": "CEU SDK", "status": "ready",
            "detail": "Loop do CEU: qualquer provedor, aprovações, desfazer e correções",
            "modes": list(ALL_MODES), "default_mode": "manual", "mode_notes": {}, "model_kinds": None,
            "caps": {"steer": True, "undo": True, "approvals": True}, "integration": None}


def _codex_sdk(probe=True):
    status, detail, integ = _integration_status(
        "codex_sdk", "Harness do Codex (app-server): ferramentas e sandbox do Codex, aprovações no CEU", probe)
    return {"id": "codex_sdk", "family": "codex_sdk", "name": "Codex SDK", "status": status, "detail": detail,
            "modes": list(ALL_MODES), "default_mode": "manual",
            "mode_notes": {
                "manual": "Sandbox somente leitura; o Codex pede aprovação para editar e para comandos",
                "accept_edits": "Edita na pasta sem perguntar; comandos fora do sandbox pedem aprovação",
                "plan": "Sandbox somente leitura, sem aprovações; termina com um plano",
                "auto": "Sandbox do Codex: escreve só na pasta, sem perguntar",
            },
            "model_kinds": ["codex"], "caps": {"steer": True, "undo": False, "approvals": True}, "integration": integ}


def _claude_sdk(probe=True):
    status, detail, integ = _integration_status(
        "claude_sdk", "Claude Agent SDK: ferramentas do Claude Code, aprovações no CEU", probe)
    return {"id": "claude_sdk", "family": "claude_sdk", "name": "Claude SDK", "status": status, "detail": detail,
            "modes": list(ALL_MODES), "default_mode": "manual",
            "mode_notes": {"auto": "bypassPermissions do SDK: edita e roda comandos sem perguntar e sem sandbox"},
            "model_kinds": ["anthropic"], "caps": {"steer": False, "undo": False, "approvals": True},
            "integration": integ}


def _redir(driver, probe=True):
    integ = None
    if not driver.implemented:
        status, detail = "planned", driver.pending or "Driver não implementado"
    elif driver.integration:
        status, detail, integ = _integration_status(
            driver.integration, "Harness, ferramentas e login do próprio CLI; o CEU supervisiona", probe)
    else:
        found = driver.find() is not None
        status = "ready" if found else "unavailable"
        detail = "Harness, ferramentas e login do próprio CLI; o CEU supervisiona" if found else \
            f"{driver.name} não encontrado neste computador"
    catalog = driver.catalog() if status == "ready" else {"models": [], "efforts": []}
    return {"id": f"redir:{driver.id}", "family": "redir", "name": driver.name, "status": status, "detail": detail,
            "modes": list(driver.modes), "default_mode": driver.default_mode, "mode_notes": dict(driver.mode_notes),
            "model_kinds": list(driver.model_kinds), "models": catalog["models"], "efforts": catalog["efforts"],
            "caps": {"steer": False, "undo": False, "approvals": False},
            "integration": integ}


def describe(probe=True):
    """Every runtime with its live state, for the client (GET /api/state)."""
    return [_ceu(), _codex_sdk(probe), _claude_sdk(probe)] + [_redir(d, probe) for d in redir.DRIVERS.values()]


def describe_cached():
    """Describe runtimes using only already-known integration state."""
    return describe(probe=False)


def get(runtime_id):
    rid = runtime_id or DEFAULT
    return next((r for r in describe() if r["id"] == rid), None)


def check_ready(runtime_id):
    """The runtime if it can run a turn now. A stale "not connected" is re-checked once, since
    the user may have logged in outside CEU meanwhile."""
    rt = get(runtime_id)
    if rt and rt["status"] == "unavailable" and rt.get("integration"):
        integrations.get(rt["integration"]["id"], refresh=True)
        rt = get(runtime_id)
    return rt


def of(conv):
    return (conv or {}).get("runtime") or DEFAULT


def driver_for(conv):
    """The REDIR driver running this session, or None for runtimes CEU runs itself."""
    rid = of(conv)
    return redir.DRIVERS.get(rid.split(":", 1)[1]) if rid.startswith("redir:") else None
