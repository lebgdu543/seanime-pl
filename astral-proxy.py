#!/usr/bin/env python3
"""
Astral-Manga Proxy Server v2.0
Bypasses Cloudflare for astral-manga.fr via SearXNG/Google index.
Use with the Seanime "Astral Manga" manga-provider extension.

Usage:
  python3 astral-proxy.py --port 8100 [--searxng http://10.89.0.3:8080]

Or with Docker:
  docker run -d --name astral-proxy -p 8100:8100 \
    -e SEARXNG_URL=http://your-searxng:8080 \
    python:3 python /app/astral-proxy.py
"""
import http.server, json, urllib.request, urllib.parse, re, os, sys, time

SEARXNG = os.environ.get('SEARXNG_URL', 'http://10.89.0.3:8080')
PORT = int(os.environ.get('PROXY_PORT', '8100'))

def sxng(q, pages=3):
    all_r = []
    for p in range(1, pages+1):
        try:
            params = urllib.parse.urlencode({'q':q,'format':'json','categories':'general','pageno':p,'language':'fr-FR'})
            r = urllib.request.urlopen(f"{SEARXNG}/search?{params}", timeout=30)
            d = json.loads(r.read())
            all_r.extend(d.get('results',[]))
            if len(d.get('results',[])) < 10: break
        except: break
        time.sleep(0.3)
    return all_r

def muuid(url):
    m = re.search(r'/manga/([a-f0-9-]+)', url)
    return m.group(1) if m else None

class H(http.server.BaseHTTPRequestHandler):
    def json(self, d, s=200):
        self.send_response(s)
        self.send_header('Content-Type','application/json')
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Access-Control-Allow-Headers','*')
        self.end_headers()
        self.wfile.write(json.dumps(d, ensure_ascii=False).encode())
    
    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(p.query)
        if p.path == '/health': return self.json({'status':'ok','searxng':SEARXNG,'port':PORT})
        if p.path == '/search': return self._search(q.get('q',[''])[0])
        if p.path == '/chapters': return self._chapters(q.get('id',[''])[0])
        self.json({'error':'not found'},404)
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Access-Control-Allow-Methods','GET,OPTIONS')
        self.send_header('Access-Control-Allow-Headers','*')
        self.end_headers()
    
    def _search(self, query):
        if not query: return self.json({'error':'missing q'},400)
        results = sxng(f'site:astral-manga.fr "{query}"', pages=3)
        mangas, seen = [], set()
        for r in results:
            url = r.get('url','')
            uid = muuid(url)
            if not uid or '/chapter/' in url or uid in seen: continue
            seen.add(uid)
            mangas.append({
                'id': uid, 'title': r.get('title','').replace(' - Astral Manga','').strip(),
                'image': '', 'description': (r.get('content','') or '')[:300],
                'year': None, 'synonyms': []
            })
        return self.json({'results': mangas})
    
    def _chapters(self, muid):
        if not muid: return self.json({'error':'missing id'},400)
        results = sxng(f'site:astral-manga.fr {muid}', pages=3)
        chapters, seen = [], set()
        for r in results:
            url = r.get('url','')
            if '/chapter/' not in url or url in seen: continue
            seen.add(url)
            title = r.get('title','')
            ch = re.search(r'Chapitre\s*([\d.]+)', title, re.IGNORECASE)
            ch_num = ch.group(1) if ch else '0'
            ch_uuid = url.split('/chapter/')[-1]
            chapters.append({'id':ch_uuid,'url':url,'title':title,'chapter':ch_num,'index':0})
        chapters.sort(key=lambda x: float(x['chapter']) if re.match(r'^[\d.]+$',x['chapter']) else 0)
        for i,ch in enumerate(chapters): ch['index'] = i
        return self.json({'chapters': chapters})
    
    def log_message(self, *a): pass

if __name__ == '__main__':
    import argparse
    a = argparse.ArgumentParser(description='Astral-Manga Proxy Server')
    a.add_argument('--port', type=int, default=PORT)
    a.add_argument('--searxng', default=SEARXNG)
    args = a.parse_args()
    SEARXNG, PORT = args.searxng, args.port
    print(f"🚀 Astral-Manga Proxy :{PORT} (SearXNG: {SEARXNG})")
    http.server.HTTPServer(('0.0.0.0', PORT), H).serve_forever()
