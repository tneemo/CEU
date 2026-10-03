"""Provider adapters. Each `stream_*` is a generator of normalized events:

  {"type": "reasoning", "text": str}
  {"type": "text", "text": str}
  {"type": "notice", "text": str}
  {"type": "final", "raw_blocks": list|None, "usage": dict|None, "stop_reason": str|None, "model": str|None,
   "tool_calls": [{"id": str, "name": str, "input": dict}]}

Errors surface as ProviderError with a user-facing message.
"""
import base64
import json
import re
import urllib.error
import urllib.request

import anthropic

from . import agent_tools, codex_bridge, db


class ProviderError(Exception):
    pass


PRESETS = {
    "anthropic": {"kind": "anthropic", "name": "Anthropic", "base_url": "https://api.anthropic.com"},
    "openai": {"kind": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1"},
    "openrouter": {"kind": "openai", "name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1"},
    "local": {"kind": "openai", "name": "Local", "base_url": "http://127.0.0.1:8080/v1"},
    "custom": {"kind": "openai", "name": "Compatível com OpenAI", "base_url": ""},
    "codex": {"kind": "codex", "name": "ChatGPT (Codex)", "base_url": ""},
}

# Models whose API takes adaptive thinking + output_config.effort.
_ADAPTIVE = ("claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
             "claude-sonnet-5", "claude-fable-5", "claude-mythos-5")
# Models that take server-side refusal fallbacks.
_FALLBACKS = ("claude-opus-5", "claude-fable-5-1")

_NON_CHAT = re.compile(r"embed|tts|whisper|dall-e|moderation|transcribe|audio|realtime|image|search|similarity|davinci|babbage|rerank", re.I)

STREAM_TIMEOUT = 600


def model_supports_effort(model_id):
    return model_id.startswith(_ADAPTIVE)


def efforts_for(model_id):
    if not model_supports_effort(model_id):
        return []
    if model_id.startswith(("claude-opus-4-6", "claude-sonnet-4-6")):
        return ["low", "medium", "high", "max"]
    return ["low", "medium", "high", "xhigh", "max"]


def default_effort(model_id):
    if model_id.startswith("claude-opus-5-5"):
        return "medium"
    return "high" if model_supports_effort(model_id) else None


# ---------------------------------------------------------------- attachments

def _classify(att):
    mime = att.get("mime", "")
    if mime in ("image/png", "image/jpeg", "image/gif", "image/webp"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    return "text"


def _load(att):
    row = db.get_attachment(att["id"])
    if not row:
        raise ProviderError(f"O anexo “{att.get('name', '?')}” não está mais disponível.")
    return row


def _text_of(row):
    return bytes(row["data"]).decode("utf-8", errors="replace")


def _file_block_text(row):
    return f'<file name="{row["name"]}">\n{_text_of(row)}\n</file>'


# ---------------------------------------------------------------- anthropic

def _anthropic_client(provider):
    key = provider.get("api_key") or ""
    if not key:
        raise ProviderError("Este provedor não tem chave de API. Adicione uma em Configurações → Provedores.")
    return anthropic.Anthropic(api_key=key, base_url=provider.get("base_url") or PRESETS["anthropic"]["base_url"],
                               max_retries=2)


def _anthropic_messages(path, strip_thinking=False):
    out = []
    for m in path:
        role = m["role"]
        if role == "user":
            blocks = []
            for att in m["attachments"]:
                row = _load(att)
                kind = _classify(att)
                data = bytes(row["data"])
                if kind == "image":
                    blocks.append({"type": "image", "source": {"type": "base64", "media_type": row["mime"],
                                                               "data": base64.standard_b64encode(data).decode()}})
                elif kind == "pdf":
                    blocks.append({"type": "document", "title": row["name"],
                                   "source": {"type": "base64", "media_type": "application/pdf",
                                              "data": base64.standard_b64encode(data).decode()}})
                else:
                    blocks.append({"type": "text", "text": _file_block_text(row)})
            if m["content"].strip():
                blocks.append({"type": "text", "text": m["content"]})
            if not blocks:
                blocks.append({"type": "text", "text": "…"})
            out.append({"role": "user", "content": blocks})
        elif role == "tool_call":
            native = (m.get("raw_blocks") or {}).get("native")
            if native:
                content = [b for b in native if not (strip_thinking and b.get("type") in ("thinking", "redacted_thinking"))]
            else:
                content = [{"type": "text", "text": m["content"] or "…"}]
            out.append({"role": "assistant", "content": content})
        elif role == "tool_result":
            results = (m.get("raw_blocks") or {}).get("tool_results") or []
            content = [{"type": "tool_result", "tool_use_id": r["id"], "content": r.get("output") or "",
                       "is_error": bool(r.get("is_error"))} for r in results]
            out.append({"role": "user", "content": content or [{"type": "text", "text": "…"}]})
        else:
            raw = m.get("raw_blocks")
            if raw and m.get("provider_kind") == "anthropic" and m["status"] == "complete":
                content = [b for b in raw if not (strip_thinking and b.get("type") in ("thinking", "redacted_thinking"))]
                if not content:
                    content = [{"type": "text", "text": m["content"] or "…"}]
            else:
                content = [{"type": "text", "text": m["content"].strip() or "(sem resposta)"}]
            out.append({"role": "assistant", "content": content})
    return out


def _block_dict(block):
    if hasattr(block, "to_dict"):
        return block.to_dict()
    return block.model_dump(mode="json", by_alias=True, exclude_none=True)


def _anthropic_error(e):
    if isinstance(e, anthropic.AuthenticationError):
        return "Chave de API da Anthropic inválida."
    if isinstance(e, anthropic.PermissionDeniedError):
        return "Sua chave não tem permissão para usar este modelo."
    if isinstance(e, anthropic.NotFoundError):
        return "Modelo não encontrado neste provedor."
    if isinstance(e, anthropic.RateLimitError):
        return "Limite de requisições atingido. Aguarde um pouco e tente novamente."
    if isinstance(e, anthropic.APIStatusError):
        msg = ""
        try:
            msg = e.body.get("error", {}).get("message", "")  # type: ignore[union-attr]
        except AttributeError:
            msg = str(e)
        if e.status_code == 529:
            return "A API da Anthropic está sobrecarregada no momento. Tente novamente em instantes."
        return f"Erro da API ({e.status_code}): {msg or e.message}"
    if isinstance(e, anthropic.APIConnectionError):
        return "Não foi possível conectar à API da Anthropic. Verifique sua conexão."
    return str(e)


def _tool_list(tools, title_mode):
    """Neutral {name, description, input_schema} list; None = the chat-mode tools."""
    if title_mode:
        return []
    return agent_tools.enabled_tools() if tools is None else tools


def stream_anthropic(provider, model, effort, system, path, cancel, max_tokens=None, title_mode=False, tools=None):
    client = _anthropic_client(provider)
    attempts = [False, True]  # second attempt strips thinking blocks (signature/prefix mismatch recovery)
    use_fallbacks = model in _FALLBACKS
    for i, strip in enumerate(attempts):
        kwargs = {
            "model": model,
            "max_tokens": max_tokens or (8192 if model.startswith("claude-3") else 64000),
            "messages": _anthropic_messages(path, strip_thinking=strip),
        }
        if system:
            kwargs["system"] = system
        tool_defs = [{"name": t["name"], "description": t["description"], "input_schema": t["input_schema"]}
                     for t in _tool_list(tools, title_mode)]
        if tool_defs:
            kwargs["tools"] = tool_defs
        if model_supports_effort(model):
            kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}
            eff = effort if effort in efforts_for(model) else default_effort(model)
            if eff:
                kwargs["output_config"] = {"effort": eff}
        try:
            if use_fallbacks and not title_mode:
                cm = client.beta.messages.stream(**kwargs, betas=["server-side-fallback-2026-07-01"],
                                                 extra_body={"fallbacks": "default"})
            else:
                cm = client.messages.stream(**kwargs)
            with cm as stream:
                cancel.on_cancel(stream.close)
                for event in stream:
                    if cancel.is_set():
                        return
                    et = event.type
                    if et == "content_block_delta":
                        d = event.delta
                        if d.type == "thinking_delta" and d.thinking:
                            yield {"type": "reasoning", "text": d.thinking}
                        elif d.type == "text_delta" and d.text:
                            yield {"type": "text", "text": d.text}
                    elif et == "content_block_start" and getattr(event.content_block, "type", "") == "fallback":
                        to = getattr(event.content_block, "to", None)
                        name = getattr(to, "model", None) or "outro modelo"
                        yield {"type": "notice", "text": f"Resposta continuada por {name}."}
                final = stream.get_final_message()
            usage = {"input": final.usage.input_tokens, "output": final.usage.output_tokens}
            if final.stop_reason == "refusal":
                details = getattr(final, "stop_details", None)
                cat = getattr(details, "category", None) if details else None
                raise ProviderError("O modelo recusou esta solicitação" + (f" (categoria: {cat})." if cat else "."))
            tool_calls = []
            if not title_mode:
                for b in final.content:
                    if getattr(b, "type", None) == "tool_use":
                        tool_calls.append({"id": b.id, "name": b.name, "input": b.input})
            yield {"type": "final", "raw_blocks": [_block_dict(b) for b in final.content], "usage": usage,
                   "stop_reason": final.stop_reason, "model": final.model, "tool_calls": tool_calls}
            return
        except ProviderError:
            raise
        except anthropic.BadRequestError as e:
            text = str(e)
            if i == 0 and "signature" in text and "thinking" in text:
                continue  # retry once with thinking blocks stripped
            if use_fallbacks and "fallback" in text.lower():
                use_fallbacks = False
                attempts.append(strip)
                continue
            raise ProviderError(_anthropic_error(e))
        except anthropic.APIError as e:
            if cancel.is_set():
                return
            raise ProviderError(_anthropic_error(e))
        except Exception:  # noqa: BLE001 - closing the stream from another thread surfaces as a transport error
            if cancel.is_set():
                return
            raise


def list_anthropic_models(provider):
    client = _anthropic_client(provider)
    try:
        return [{"id": m.id, "name": m.display_name or m.id} for m in client.models.list(limit=100)]
    except anthropic.APIError as e:
        raise ProviderError(_anthropic_error(e))


# ---------------------------------------------------------------- openai-compatible

def _openai_headers(provider):
    h = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if provider.get("api_key"):
        h["Authorization"] = "Bearer " + provider["api_key"]
    if provider.get("preset") == "openrouter":
        h["X-Title"] = "CEU"
    return h


def _openai_url(provider, suffix):
    base = (provider.get("base_url") or "").rstrip("/")
    if not base:
        raise ProviderError("Este provedor não tem URL base configurada.")
    return base + suffix


def _openai_messages(path, system):
    out = []
    if system:
        out.append({"role": "system", "content": system})
    for m in path:
        role = m["role"]
        if role == "user":
            texts, images = [], []
            for att in m["attachments"]:
                row = _load(att)
                kind = _classify(att)
                if kind == "image":
                    images.append({"type": "image_url", "image_url": {
                        "url": f"data:{row['mime']};base64," + base64.standard_b64encode(bytes(row["data"])).decode()}})
                elif kind == "pdf":
                    raise ProviderError("Este provedor não aceita PDFs. Use um modelo da Anthropic ou envie o texto.")
                else:
                    texts.append(_file_block_text(row))
            if m["content"].strip():
                texts.append(m["content"])
            text = "\n\n".join(texts) or "…"
            if images:
                out.append({"role": "user", "content": [{"type": "text", "text": text}] + images})
            else:
                out.append({"role": "user", "content": text})
        elif role == "tool_call":
            calls = (m.get("raw_blocks") or {}).get("tool_calls") or []
            msg = {"role": "assistant", "content": m["content"] or ""}
            if calls:
                msg["tool_calls"] = [{"id": c["id"], "type": "function",
                                      "function": {"name": c["name"], "arguments": json.dumps(c.get("input") or {})}}
                                     for c in calls]
            out.append(msg)
        elif role == "tool_result":
            for r in (m.get("raw_blocks") or {}).get("tool_results") or []:
                out.append({"role": "tool", "tool_call_id": r["id"], "content": r.get("output") or ""})
        else:
            out.append({"role": "assistant", "content": m["content"].strip() or "(sem resposta)"})
    return out


def _http_error(e):
    try:
        body = e.read().decode("utf-8", errors="replace")
        data = json.loads(body)
        err = data.get("error")
        msg = err.get("message") if isinstance(err, dict) else (err or body)
    except Exception:  # noqa: BLE001 - best effort
        msg = getattr(e, "reason", "") or ""
    if e.code == 401:
        return "Chave de API inválida ou ausente."
    if e.code == 404:
        return f"Modelo ou endpoint não encontrado. {msg}".strip()
    if e.code == 429:
        return "Limite de requisições atingido. Aguarde um pouco e tente novamente."
    return f"Erro do provedor ({e.code}): {msg}"


class _ThinkSplitter:
    """Splits inline <think>…</think> reasoning out of content streams."""

    def __init__(self):
        self.buf = ""
        self.state = "start"  # start | think | text

    def feed(self, chunk):
        self.buf += chunk
        out = []
        while self.buf:
            if self.state == "start":
                stripped = self.buf.lstrip()
                if "<think>".startswith(stripped) and len(stripped) < 7:
                    break  # could still become <think>
                if stripped.startswith("<think>"):
                    self.buf = stripped[7:]
                    self.state = "think"
                else:
                    self.state = "text"
            elif self.state == "think":
                i = self.buf.find("</think>")
                if i >= 0:
                    if i:
                        out.append(("reasoning", self.buf[:i]))
                    self.buf = self.buf[i + 8:].lstrip("\n")
                    self.state = "text"
                else:
                    keep = 0
                    for k in range(1, 8):
                        if "</think>".startswith(self.buf[-k:]):
                            keep = k
                    emit = self.buf[:len(self.buf) - keep]
                    if emit:
                        out.append(("reasoning", emit))
                    self.buf = self.buf[len(self.buf) - keep:]
                    break
            else:
                out.append(("text", self.buf))
                self.buf = ""
        return out

    def flush(self):
        rest, self.buf = self.buf, ""
        if not rest:
            return []
        return [("reasoning" if self.state == "think" else "text", rest)]


def stream_openai(provider, model, system, path, cancel, extra=None, title_mode=False, tools=None):
    body = {"model": model, "messages": _openai_messages(path, system), "stream": True,
            "stream_options": {"include_usage": True}}
    tool_defs = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                   "parameters": t["input_schema"]}}
                 for t in _tool_list(tools, title_mode)]
    if tool_defs:
        body["tools"] = tool_defs
    if extra:
        body.update(extra)
    req = urllib.request.Request(_openai_url(provider, "/chat/completions"), data=json.dumps(body).encode(),
                                 headers=_openai_headers(provider), method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=STREAM_TIMEOUT)
    except urllib.error.HTTPError as e:
        raise ProviderError(_http_error(e))
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise ProviderError(f"Não foi possível conectar a {provider.get('base_url')}: {reason}")

    splitter = _ThinkSplitter()
    usage = None
    finish = None
    served_model = None
    tool_acc = {}
    cancel.on_cancel(resp.close)
    try:
        for raw in resp:
            if cancel.is_set():
                return
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except ValueError:
                continue
            if chunk.get("error"):
                err = chunk["error"]
                raise ProviderError(err.get("message") if isinstance(err, dict) else str(err))
            served_model = chunk.get("model") or served_model
            if chunk.get("usage"):
                u = chunk["usage"]
                usage = {"input": u.get("prompt_tokens"), "output": u.get("completion_tokens")}
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                r = delta.get("reasoning_content") or delta.get("reasoning")
                if r:
                    yield {"type": "reasoning", "text": r}
                c = delta.get("content")
                if c:
                    for kind, text in splitter.feed(c):
                        yield {"type": kind, "text": text}
                for tc in delta.get("tool_calls") or []:
                    idx = tc.get("index", 0)
                    slot = tool_acc.setdefault(idx, {"id": None, "name": None, "arguments": ""})
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["name"] = fn["name"]
                    if fn.get("arguments"):
                        slot["arguments"] += fn["arguments"]
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]
    except ProviderError:
        raise
    except Exception as e:  # noqa: BLE001 - closing the response from another thread surfaces as assorted errors
        if cancel.is_set():
            return
        raise ProviderError(f"A conexão com o provedor foi interrompida: {e}")
    finally:
        try:
            resp.close()
        except Exception:  # noqa: BLE001
            pass
    for kind, text in splitter.flush():
        yield {"type": kind, "text": text}
    if finish == "length":
        yield {"type": "notice", "text": "A resposta atingiu o limite de tokens do modelo."}
    tool_calls = []
    if finish == "tool_calls":
        for idx in sorted(tool_acc):
            slot = tool_acc[idx]
            try:
                parsed = json.loads(slot["arguments"] or "{}")
            except ValueError:
                parsed = {}
            tool_calls.append({"id": slot["id"] or f"call_{idx}", "name": slot["name"], "input": parsed})
    yield {"type": "final", "raw_blocks": None, "usage": usage, "stop_reason": finish, "model": served_model,
          "tool_calls": tool_calls}


def list_openai_models(provider):
    req = urllib.request.Request(_openai_url(provider, "/models"), headers=_openai_headers(provider))
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ProviderError(_http_error(e))
    except (urllib.error.URLError, OSError) as e:
        raise ProviderError(f"Não foi possível conectar a {provider.get('base_url')}: {getattr(e, 'reason', e)}")
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        items = data.get("models", []) if isinstance(data, dict) else []
    models = []
    for m in items:
        mid = m.get("id") or m.get("name") if isinstance(m, dict) else str(m)
        if not mid or _NON_CHAT.search(mid):
            continue
        name = (m.get("name") if isinstance(m, dict) and provider.get("preset") == "openrouter" else None) or mid
        models.append({"id": mid, "name": name})
    models.sort(key=lambda x: x["name"].lower())
    return models


# ---------------------------------------------------------------- codex (ChatGPT OAuth via app-server)

def _codex_transcript(path):
    """Folds the message path into one text blob: each generation opens a fresh
    ephemeral app-server thread (matching how CEU already treats every other
    provider as stateless — the full history is resent every time), so this is
    what the model actually sees as its single turn input."""
    parts = []
    for m in path:
        role = m["role"]
        if role == "user":
            texts = []
            for att in m["attachments"]:
                row = _load(att)
                if _classify(att) != "text":
                    raise ProviderError("O provedor ChatGPT (Codex) só aceita anexos de texto neste app.")
                texts.append(_file_block_text(row))
            if m["content"].strip():
                texts.append(m["content"])
            parts.append("Usuário: " + ("\n\n".join(texts) or "…"))
        elif role in ("tool_call", "tool_result"):
            continue
        else:
            parts.append("Assistente: " + (m["content"].strip() or "(sem resposta)"))
    return "\n\n".join(parts)


def stream_codex(provider, model, effort, system, path, cancel, conversation_id=None, tools=None, tool_executor=None):
    transcript = _codex_transcript(path)
    try:
        for ev in codex_bridge.run_turn(system, transcript, model, cancel, effort=effort,
                                        conversation_id=conversation_id, tools=tools, tool_executor=tool_executor):
            if ev["type"] == "final":
                yield {"type": "final", "raw_blocks": None, "usage": ev.get("usage"),
                      "stop_reason": "stop", "model": model, "tool_calls": []}
            else:
                yield ev
    except codex_bridge.CodexError as e:
        raise ProviderError(str(e))


def list_codex_models(provider):
    try:
        return codex_bridge.list_models()
    except codex_bridge.CodexError as e:
        raise ProviderError(str(e))


# ---------------------------------------------------------------- dispatch

def stream(provider, model, effort, system, path, cancel, conversation_id=None, tools=None, tool_executor=None):
    """`tools` (neutral {name, description, input_schema} dicts) defaults to the chat-mode tools.
    Codex runs tool calls inside its own turn, through `tool_executor(name, args)`; the other
    providers return them in the final event for generation.py's loop."""
    if provider["kind"] == "anthropic":
        return stream_anthropic(provider, model, effort, system, path, cancel, tools=tools)
    if provider["kind"] == "codex":
        return stream_codex(provider, model, effort, system, path, cancel, conversation_id=conversation_id,
                            tools=tools, tool_executor=tool_executor)
    # Local servers (llama.cpp) default to unlimited generation; a reasoning loop would never end.
    extra = {"max_tokens": 16384} if provider.get("preset") == "local" else None
    return stream_openai(provider, model, system, path, cancel, extra=extra, tools=tools)


def list_models(provider):
    if provider["kind"] == "anthropic":
        return list_anthropic_models(provider)
    if provider["kind"] == "codex":
        return list_codex_models(provider)
    return list_openai_models(provider)


def complete_short(provider, model, system, prompt, cancel, limit=200):
    """Small non-UI completion (titles). Returns text."""
    path = [{"role": "user", "content": prompt, "attachments": [], "status": "complete"}]
    if provider["kind"] == "anthropic":
        gen = stream_anthropic(provider, model, "low", system, path, cancel, max_tokens=4000, title_mode=True)
    elif provider["kind"] == "codex":
        gen = stream_codex(provider, model, "low", system, path, cancel)
    else:
        if provider.get("preset") == "openai":
            extra = {"max_completion_tokens": 2000}
        else:
            extra = {"max_tokens": 400}
            if provider.get("preset") == "local":
                extra["chat_template_kwargs"] = {"enable_thinking": False}
        gen = stream_openai(provider, model, system, path, cancel, extra=extra, title_mode=True)
    text = ""
    reasoning = 0
    try:
        for ev in gen:
            if ev["type"] == "text":
                text += ev["text"]
            elif ev["type"] == "reasoning":
                reasoning += len(ev["text"])
            if len(text) > limit or reasoning > 6000:
                cancel.set()
                break
    finally:
        gen.close()  # closes the HTTP stream so the server stops generating
    return text
