#!/usr/bin/env python3
"""
Astral Manga Catalog Extractor via SearXNG
Extrait le catalogue complet des mangas d'astral-manga.fr
en contournant Cloudflare via SearXNG/Google cache
"""
import requests
import json
import re
import sys
import os
from urllib.parse import quote

SEARXNG_URL = "http://10.89.0.3:8080"
OUTPUT_DIR = "/app/data/dev/astral_output"

def search(query, category="general", pages=1):
    """Multi-page search via SearXNG"""
    all_results = []
    for page in range(1, pages + 1):
        params = {
            'q': query,
            'format': 'json',
            'categories': category,
            'pageno': page,
            'language': 'fr-FR'
        }
        try:
            r = requests.get(f"{SEARXNG_URL}/search", params=params, timeout=30)
            if r.status_code == 200:
                data = r.json()
                all_results.extend(data.get('results', []))
                if not data.get('results'):
                    break
        except Exception as e:
            print(f"Error page {page}: {e}", file=sys.stderr)
            break
    return all_results

def extract_manga_uuid(url):
    """Extract manga UUID from URL"""
    m = re.search(r'/manga/([a-f0-9-]+)', url)
    return m.group(1) if m else None

def extract_chapter_info(url, title):
    """Extract chapter number and manga UUID"""
    parts = url.split('/')
    manga_uuid = None
    chapter_uuid = None
    for i, p in enumerate(parts):
        if p == 'manga' and i + 1 < len(parts):
            manga_uuid = parts[i + 1]
        if p == 'chapter' and i + 1 < len(parts):
            chapter_uuid = parts[i + 1]
    
    # Extract chapter number from title
    ch_num = None
    m = re.search(r'Chapitre\s*(\d+)', title, re.IGNORECASE)
    if m:
        ch_num = m.group(1)
    
    return {
        'manga_uuid': manga_uuid,
        'chapter_uuid': chapter_uuid,
        'chapter_num': ch_num
    }

def get_full_catalog():
    """Get all mangas from astral-manga.fr"""
    results = search("site:astral-manga.fr")
    
    mangas = {}
    chapters = []
    
    for r in results:
        url = r.get('url', '')
        title = r.get('title', '')
        content = r.get('content', '')
        
        # Extract manga info
        manga_uuid = extract_manga_uuid(url)
        
        if manga_uuid and '/chapter/' in url:
            info = extract_chapter_info(url, title)
            chapters.append({
                'url': url,
                'title': title,
                **info
            })
        elif manga_uuid and manga_uuid not in mangas:
            mangas[manga_uuid] = {
                'uuid': manga_uuid,
                'url': url,
                'title': title,
                'description': content,
                'chapters': []
            }
    
    # Associate chapters with mangas
    for ch in chapters:
        muid = ch.get('manga_uuid')
        if muid in mangas:
            mangas[muid]['chapters'].append(ch)
    
    return list(mangas.values()), chapters

def save_catalog():
    """Save catalog to file"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    mangas, chapters = get_full_catalog()
    
    output = {
        'total_mangas': len(mangas),
        'total_chapters': len(chapters),
        'mangas': mangas,
        'chapters': chapters,
        'query_date': '2026-06-30'
    }
    
    path = os.path.join(OUTPUT_DIR, 'manga_catalog.json')
    with open(path, 'w') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"✅ Catalog saved: {path}")
    print(f"   {len(mangas)} mangas, {len(chapters)} chapters")
    return output

if __name__ == '__main__':
    if len(sys.argv) > 1:
        # Search specific manga
        manga_name = ' '.join(sys.argv[1:])
        results = search(f"site:astral-manga.fr {manga_name}")
        for r in results:
            url = r.get('url', '')
            if '/manga/' in url and '/chapter/' not in url:
                print(f"\n📚 {r.get('title')}")
                print(f"   URL: {url}")
                print(f"   {r.get('content', '')[:200]}")
    else:
        save_catalog()
