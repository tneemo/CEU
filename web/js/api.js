export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor do CEU. Ele ainda está em execução?', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(data?.error || `Erro ${res.status}`, res.status);
  return data;
}

export const api = {
  state: () => req('GET', '/api/state'),
  settings: (patch) => req('PUT', '/api/settings', patch),
  conversations: () => req('GET', '/api/conversations'),
  conversation: (id) => req('GET', `/api/conversations/${id}`),
  updateConversation: (id, patch) => req('PATCH', `/api/conversations/${id}`, patch),
  deleteConversation: (id) => req('DELETE', `/api/conversations/${id}`),
  restoreConversation: (id) => req('POST', `/api/conversations/${id}/restore`),
  deleteAll: () => req('DELETE', '/api/conversations'),
  search: (q) => req('GET', `/api/search?q=${encodeURIComponent(q)}`),
  chat: (body) => req('POST', '/api/chat', body),
  regenerate: (id, body) => req('POST', `/api/messages/${id}/regenerate`, body),
  edit: (id, body) => req('POST', `/api/messages/${id}/edit`, body),
  stop: (id) => req('POST', `/api/messages/${id}/stop`),
  createProvider: (body) => req('POST', '/api/providers', body),
  updateProvider: (id, patch) => req('PATCH', `/api/providers/${id}`, patch),
  refreshProvider: (id) => req('POST', `/api/providers/${id}/refresh`),
  deleteProvider: (id) => req('DELETE', `/api/providers/${id}`),
  codexAccount: () => req('GET', '/api/providers/codex/account'),
  codexLoginStart: () => req('POST', '/api/providers/codex/login/start'),
  codexLoginWait: (loginId) => req('POST', '/api/providers/codex/login/wait', { loginId }),
  codexLoginCancel: (loginId) => req('POST', '/api/providers/codex/login/cancel', { loginId }),

  async upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/attachments');
      x.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'colado.png'));
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => {
        let data = null;
        try { data = JSON.parse(x.responseText); } catch { /* ignore */ }
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(new ApiError(data?.error || `Falha no envio (${x.status})`, x.status));
      };
      x.onerror = () => reject(new ApiError('Falha de rede ao enviar o arquivo.', 0));
      x.send(file);
    });
  },

  /** Attach to a generation. Returns a close() function. */
  stream(messageId, handlers) {
    const es = new EventSource(`/api/stream/${messageId}`);
    let finished = false;
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      handlers.event?.(ev);
      if (ev.type === 'done' || ev.type === 'error') {
        finished = true;
        es.close();
      }
    };
    es.onerror = () => {
      if (finished) return;
      es.close();
      handlers.lost?.();
    };
    return () => { finished = true; es.close(); };
  },

  events(onEvent) {
    let es;
    let retry = 1000;
    const open = () => {
      es = new EventSource('/api/events');
      es.onopen = () => { retry = 1000; };
      es.onmessage = (e) => onEvent(JSON.parse(e.data));
      es.onerror = () => {
        es.close();
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    open();
  },
};
