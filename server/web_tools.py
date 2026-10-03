"""Web access for agents: keyless search (DuckDuckGo's HTML endpoint) and page fetching
with HTML → text. Standard library only.

fetch_url refuses loopback, private and link-local hosts, so a prompt-injected page can't
steer the agent into this machine's own services (the CEU API itself listens on 127.0.0.1).
"""
import html
import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
MAX_BYTES = 3 * 1024 * 1024
PAGE_CHARS = 8000


class WebError(Exception):
    pass


# ---------------------------------------------------------------- search

_RESULT = re.compile(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]+class="result__a"|$)', re.S)
_SNIPPET = re.compile(r'class="result__snippet"[^>]*>(.*?)</a>', re.S)


def _strip(fragment):
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def _real_url(href):
    """DuckDuckGo wraps results in //duckduckgo.com/l/?uddg=<url>."""
    if href.startswith("//"):
        href = "https:" + href
    q = urllib.parse.urlsplit(href)
    if q.netloc.endswith("duckduckgo.com") and q.path.startswith("/l/"):
        target = urllib.parse.parse_qs(q.query).get("uddg")
        if target:
            return target[0]
    return href


def search(query, max_results=8):
    query = (query or "").strip()
    if not query:
        raise WebError("A busca está vazia.")
    body = urllib.parse.urlencode({"q": query, "kl": "br-pt"}).encode()
    req = urllib.request.Request("https://html.duckduckgo.com/html/", data=body,
                                 headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            page = r.read(MAX_BYTES).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as e:
        raise WebError(f"Falha na busca: {getattr(e, 'reason', e)}")
    out = []
    for m in _RESULT.finditer(page):
        url = _real_url(html.unescape(m.group(1)))
        if "duckduckgo.com/y.js" in url:  # ads
            continue
        snip = _SNIPPET.search(m.group(3))
        out.append({"title": _strip(m.group(2)), "url": url, "snippet": _strip(snip.group(1)) if snip else ""})
        if len(out) >= max_results:
            break
    return out


def format_results(query, results):
    if not results:
        return f"Nenhum resultado para “{query}”."
    lines = [f"Resultados para “{query}”:"]
    for i, r in enumerate(results, 1):
        lines.append(f"\n{i}. {r['title']}\n   {r['url']}" + (f"\n   {r['snippet']}" if r["snippet"] else ""))
    return "\n".join(lines)


# ---------------------------------------------------------------- fetch

def _check_host(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise WebError("Só endereços http(s) podem ser abertos.")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror:
        raise WebError(f"Não foi possível resolver “{parts.hostname}”.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise WebError("Endereços locais ou de rede privada não podem ser abertos pelo agente.")


class _NoLocalRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template", "head"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header",
             "footer", "pre", "blockquote", "table", "ul", "ol", "dt", "dd", "hr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip, self.title, self._in_title = [], 0, "", False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")
        if tag in ("h1", "h2", "h3") and not self.skip:
            self.parts.append("# ")
        if tag == "li" and not self.skip:
            self.parts.append("- ")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if not self.skip:
            self.parts.append(data)

    def text(self):
        raw = "".join(self.parts)
        raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
        raw = re.sub(r" *\n *", "\n", raw)
        return re.sub(r"\n{3,}", "\n\n", raw).strip()


def fetch(url, offset=0, max_chars=PAGE_CHARS):
    url = (url or "").strip()
    _check_host(url)
    opener = urllib.request.build_opener(_NoLocalRedirects)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
                                               "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"})
    try:
        with opener.open(req, timeout=25) as r:
            ctype = r.headers.get("Content-Type", "")
            data = r.read(MAX_BYTES)
            final = r.geturl()
    except urllib.error.HTTPError as e:
        raise WebError(f"O site respondeu com erro {e.code}.")
    except (urllib.error.URLError, OSError) as e:
        raise WebError(f"Falha ao abrir a página: {getattr(e, 'reason', e)}")
    charset = re.search(r"charset=([\w-]+)", ctype)
    body = data.decode(charset.group(1) if charset else "utf-8", "replace")
    title = ""
    if "html" in ctype or body.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        p = _Text()
        p.feed(body)
        text, title = p.text(), " ".join(p.title.split())
    elif ctype.startswith(("text/", "application/json", "application/xml")):
        text = body
    else:
        raise WebError(f"Conteúdo não textual ({ctype or 'desconhecido'}); baixe com run_code se precisar dele.")
    offset = max(0, int(offset or 0))
    chunk = text[offset:offset + max_chars]
    head = f"{title}\n{final}\n" if title else f"{final}\n"
    rest = len(text) - offset - len(chunk)
    tail = f"\n\n[… mais {rest} caracteres; chame fetch_url com offset={offset + len(chunk)} para continuar]" if rest > 0 else ""
    return head + "\n" + chunk + tail, {"url": final, "title": title, "chars": len(text)}
