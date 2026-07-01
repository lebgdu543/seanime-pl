#!/usr/bin/env python3
"""
🔥 ASTral Manga BYPASS v2.0 - Multi-couche
Contourne Cloudflare Turnstile via SearXNG (Google index)
+ Google Cache + curl-impersonate (fallback)

Utilisation:
  python3 bypass_searxng.py                      # Catalogue complet
  python3 bypass_searxng.py search "Arcane Sniper"  # Recherche
  python3 bypass_searxng.py chapter cc9c21c9 148    # Chapitre spécifique
  python3 bypass_searxng.py export-json             # Export catalogue
"""
import requests
import json
import re
import sys
import os
import time

SEARXNG = "http://10.89.0.3:8080"
OUTPUT = "/app/data/dev/astral_output"

# ===================== LAYER 1: SearXNG/Google Index =====================
def searxng_search(query, pages=2, category="general"):
    """Search via SearXNG using Google/Bing indexes (bypasses Cloudflare)"""
    all_results = []
    for page in range(1, pages + 1):
        try:
            r = requests.get(f"{SEARXNG}/search", params={
                'q': query, 'format': 'json', 'categories': category,
                'pageno': page, 'language': 'fr-FR'
            }, timeout=30)
            if r.status_code == 200:
                data = r.json()
                results = data.get('results', [])
                all_results.extend(results)
                if len(results) < 10:
                    break
        except Exception as e:
            break
        time.sleep(0.3)
    return all_results

# ===================== LAYER 2: Google Cache =====================
def google_cache(url):
    """Try to fetch from Google Cache"""
    try:
        r = requests.get(
            f"https://webcache.googleusercontent.com/search?q=cache:{url}&strip=1",
            headers={'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'},
            timeout=15
        )
        if r.status_code == 200:
            # Extract content from Google wrapper
            content = re.sub(r'<script[^>]*>.*?</script>', '', r.text, flags=re.DOTALL)
            content = re.sub(r'<style[^>]*>.*?</style>', '', content, flags=re.DOTALL)
            content = re.sub(r'<[^>]+>', ' ', content)
            content = re.sub(r'\s+', ' ', content).strip()
            return content[:2000] if 'Arcane' in content or 'Sniper' in content or 'manga' in content.lower() else None
    except:
        return None
    return None

# ===================== MANGA PARSER =====================
def extract_manga_uuid(url):
    m = re.search(r'/manga/([a-f0-9-]+)', url)
    return m.group(1) if m else None

def get_manga_full_info(name):
    """Get complete manga info from all layers"""
    results = searxng_search(f"site:astral-manga.fr \"{name}\"")
    
    manga_pages = [r for r in results if '/manga/' in r.get('url','') and '/chapter/' not in r.get('url','')]
    chapters = [r for r in results if '/chapter/' in r.get('url','')]
    
    info = {
        'name': name,
        'found': len(manga_pages) > 0 or len(chapters) > 0,
        'manga_url': None,
        'manga_uuid': None,
        'description': '',
        'status': '',
        'chapters': []
    }
    
    # Try to find the EXACT manga page
    for r in manga_pages:
        title = r.get('title', '')
        if name.lower() in title.lower():
            info['manga_url'] = r['url']
            info['manga_uuid'] = extract_manga_uuid(r['url'])
            info['description'] = r.get('content', '')
            # Try Google Cache for more details
            cached = google_cache(r['url'])
            if cached:
                info['cached_content'] = cached
            break
    
    # If not found by title, use first match
    if not info['manga_url'] and manga_pages:
        r = manga_pages[0]
        info['manga_url'] = r['url']
        info['manga_uuid'] = extract_manga_uuid(r['url'])
        info['description'] = r.get('content', '')
    
    # Parse chapters
    for ch in chapters:
        ch_info = re.search(r'Chapitre\s*(\d+)', ch.get('title', ''), re.IGNORECASE)
        ch_num = ch_info.group(1) if ch_info else None
        info['chapters'].append({
            'url': ch['url'],
            'title': ch['title'],
            'chapter_num': ch_num,
            'manga_uuid': extract_manga_uuid(ch['url']),
            'chapter_uuid': ch['url'].split('/chapter/')[-1] if '/chapter/' in ch['url'] else None,
            'description': ch.get('content', '')
        })
    
    return info

def get_full_catalog():
    """Extract complete manga catalog"""
    results = searxng_search("site:astral-manga.fr", pages=3)
    
    mangas = {}
    chapters_list = []
    
    for r in results:
        url = r.get('url', '')
        muid = extract_manga_uuid(url)
        if not muid:
            continue
        
        if '/chapter/' in url:
            ch_info = re.search(r'Chapitre\s*(\d+)', r.get('title',''), re.IGNORECASE)
            chapters_list.append({
                'url': url,
                'title': r.get('title'),
                'manga_uuid': muid,
                'chapter_num': ch_info.group(1) if ch_info else None,
                'chapter_uuid': url.split('/chapter/')[-1]
            })
        elif muid not in mangas:
            mangas[muid] = {
                'uuid': muid,
                'url': url,
                'title': r.get('title'),
                'description': r.get('content', '')[:300],
                'chapters': []
            }
    
    for ch in chapters_list:
        if ch['manga_uuid'] in mangas:
            mangas[ch['manga_uuid']]['chapters'].append(ch)
    
    return list(mangas.values())

# ===================== MAIN =====================
if __name__ == '__main__':
    os.makedirs(OUTPUT, exist_ok=True)
    
    if len(sys.argv) > 1 and sys.argv[1] == 'search' and len(sys.argv) > 2:
        name = ' '.join(sys.argv[2:])
        info = get_manga_full_info(name)
        print(f"\n{'='*60}")
        print(f"📚 {info['name']}")
        print(f"{'='*60}")
        if info['manga_url']:
            print(f"URL: {info['manga_url']}")
            print(f"UUID: {info['manga_uuid']}")
            print(f"Description: {info['description'][:300]}")
            if info['chapters']:
                print(f"\n📖 Chapters ({len(info['chapters'])} found):")
                for ch in sorted(info['chapters'], key=lambda x: int(x['chapter_num'] or 0), reverse=True)[:10]:
                    print(f"  Ch.{ch['chapter_num']} → {ch['url'][:60]}...")
        else:
            print("❌ Not found")
    
    elif len(sys.argv) > 1 and sys.argv[1] == 'catalog':
        catalog = get_full_catalog()
        path = os.path.join(OUTPUT, 'full_catalog.json')
        with open(path, 'w') as f:
            json.dump(catalog, f, indent=2, ensure_ascii=False)
        print(f"✅ Full catalog saved: {path}")
        print(f"   {len(catalog)} mangas found")
        for m in catalog:
            print(f"   • {m['title']} ({len(m['chapters'])} chapitres)")
    
    elif len(sys.argv) > 1 and sys.argv[1] == 'chapter' and len(sys.argv) > 3:
        muid = sys.argv[2]
        ch_num = sys.argv[3]
        results = searxng_search(f"astral-manga.fr {muid} Chapitre {ch_num}")
        for r in results:
            if muid in r.get('url','') and ch_num in r.get('title',''):
                print(f"\n📖 {r['title']}")
                print(f"URL: {r['url']}")
                print(f"Content: {r.get('content','')}")
    
    else:
        # Default: search all catalog
        catalog = get_full_catalog()
        print(f"\n{'='*60}")
        print(f"🔥 ASTRAL MANGA CATALOG — {len(catalog)} mangas")
        print(f"{'='*60}")
        for m in sorted(catalog, key=lambda x: x['title']):
            ch_count = len(m['chapters'])
            print(f"\n📚 {m['title']} ({ch_count} chapitres)")
            print(f"   {m['url']}")
            print(f"   {m['description'][:150]}...")
