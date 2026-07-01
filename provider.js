/// <reference path="./manga-provider.d.ts" />

/**
 * Seanime Manga Provider for Astral-Manga.fr v3.0.0
 *
 * THREE modes of operation:
 *   1. DIRECT (primary) — uses cf_clearance cookie from $store (bridge plugin) or userConfig
 *   2. PROXY (fallback)  — uses a SearXNG proxy server for search/chapters data
 *   3. HYBRID — proxy for text, cookies for images
 *
 * Configuration (userConfig):
 *   - cfClearance (text): Your cf_clearance cookie from astral-manga.fr browser
 *   - proxyUrl (text): URL of the astral-proxy.py server (default: http://localhost:8100)
 */

class Provider {
    constructor() {
        this.api = 'https://astral-manga.fr';
    }

    getSettings() {
        return { supportsMultiLanguage: false, supportsMultiScanlator: false };
    }

    // =================================================================
    //  Cookie helpers
    // =================================================================

    _getCookies() {
        // Priority 1: $store (from astral-bridge plugin)
        try {
            var stored = $store.get('astral-manga-cookies');
            if (stored && stored.cf_clearance) {
                return 'cf_clearance=' + stored.cf_clearance + (stored.__cf_bm ? '; __cf_bm=' + stored.__cf_bm : '');
            }
        } catch (e) {}

        // Priority 2: userConfig (manual paste)
        try {
            var manual = "{{cfClearance}}";
            if (manual && manual.length > 5) {
                return 'cf_clearance=' + manual;
            }
        } catch (e) {}

        return '';
    }

    _hasCookies() {
        return this._getCookies().length > 5;
    }

    _getProxyUrl() {
        var url = "{{proxyUrl}}";
        if (!url || url === '' || url.indexOf('{{') === 0) { return 'http://localhost:8100'; }
        return url;
    }

    // =================================================================
    //  Fetch helpers
    // =================================================================

    async _fetch(url, extraHeaders) {
        var headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': this.api + '/',
        };
        var cookies = this._getCookies();
        if (cookies) { headers['Cookie'] = cookies; }
        if (extraHeaders) {
            for (var k in extraHeaders) { headers[k] = extraHeaders[k]; }
        }
        return fetch(url, { headers: headers, noCloudflareBypass: false, redirect: 'follow' });
    }

    async _proxyFetch(path, params) {
        var proxyUrl = this._getProxyUrl();
        var url = proxyUrl + path;
        if (params) { url += '?' + params; }
        try {
            var res = await fetch(url, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) { return null; }
            return await res.json();
        } catch (e) {
            console.warn('[astral] proxy error:', e.message);
            return null;
        }
    }

    // =================================================================
    //  Provider Interface
    // =================================================================

    async search(opts) {
        var q = (opts.query || '').trim();
        if (!q) return [];

        // Try direct API first (requires cookies)
        if (this._hasCookies()) {
            try {
                var searchUrl = this.api + '/api/mangas?query=' + encodeURIComponent(q) + '&page=1&pageSize=12';
                var res = await this._fetch(searchUrl);
                if (res.ok) {
                    var data = await res.json();
                    if (data && data.mangas && data.mangas.length > 0) {
                        return data.mangas.map(function(m) {
                            return { id: m.urlId || m.id, title: m.title || m.name, image: m.image || '', description: (m.synopsis || m.description || '').substring(0, 300), year: m.year || null, synonyms: m.synonyms || [] };
                        });
                    }
                }
            } catch (e) { console.warn('[astral] direct search failed, trying proxy...'); }
        }

        // Fallback: proxy
        var data = await this._proxyFetch('/search', 'q=' + encodeURIComponent(q));
        return (data && data.results) ? data.results : [];
    }

    async findChapters(mangaId) {
        if (!mangaId) return [];

        // Try direct API first
        if (this._hasCookies()) {
            try {
                var url = this.api + '/manga/' + mangaId;
                var res = await this._fetch(url);
                if (res.ok) {
                    var html = await res.text();
                    var parsed = this._parseRSC(html);
                    if (parsed && parsed.type === 'manga' && parsed.data.chapters) {
                        return parsed.data.chapters.map(function(ch, i) {
                            return { id: mangaId + '::' + (ch.id || ch.slug || i), url: url + '/chapter/' + (ch.slug || ch.id), title: ch.title || ('Chapter ' + (ch.orderId || i + 1)), chapter: String(ch.orderId || ch.number || i + 1), index: i };
                        });
                    }
                    // Fallback: try to find chapters in RSC
                    var rsc = this._parseRSC(html);
                    if (rsc && typeof rsc === 'object') {
                        var allCh = this._findAllChapters(rsc, mangaId, []);
                        if (allCh.length > 0) {
                            return allCh.map(function(ch, i) {
                                return { id: mangaId + '::' + ch.id, url: url + '/chapter/' + ch.id, title: 'Chapter ' + (ch.orderId || i + 1), chapter: String(ch.orderId || i + 1), index: i };
                            });
                        }
                    }
                }
            } catch (e) { console.warn('[astral] direct chapters failed, trying proxy...'); }
        }

        // Fallback: proxy
        var data = await this._proxyFetch('/chapters', 'id=' + encodeURIComponent(mangaId));
        if (!data || !data.chapters) return [];
        // Encode manga UUID into chapter ids
        for (var i = 0; i < data.chapters.length; i++) {
            data.chapters[i].id = mangaId + '::' + data.chapters[i].id;
        }
        return data.chapters;
    }

    async findChapterPages(combinedId) {
        if (!combinedId) return [];
        var parts = combinedId.split('::');
        var mangaUuid = parts[0] || '';
        var chapterUuid = parts[1] || parts[0];
        var url = this.api + '/manga/' + mangaUuid + '/chapter/' + chapterUuid;
        var userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
        var headers = { 'User-Agent': userAgent, 'Accept': 'text/html,*/*', 'Accept-Language': 'fr-FR,fr;q=0.9', 'Referer': this.api + '/' };
        var cookies = this._getCookies();
        if (cookies) { headers['Cookie'] = cookies; }

        try {
            var res = await fetch(url, { headers: headers, noCloudflareBypass: false, redirect: 'follow' });
            if (!res.ok && cookies) {
                res = await fetch(url, { headers: headers, noCloudflareBypass: true });
            }
            if (!res.ok) {
                console.warn('[astral] need cf_clearance cookie for chapter images');
                return [];
            }
            var html = await res.text();
            var doc = LoadDoc(html);
            var pages = [];

            // Priority selectors for manga readers
            var selectors = [
                '.reading-content img', '.page-break img', '.chapter-content img',
                '.manga-page img', 'img.page-image', '.reader-container img',
                '#images img', 'amp-img', '.wp-manga-chapter-img',
                'img[loading="lazy"]', 'div.text-center img'
            ];
            for (var s = 0; s < selectors.length; s++) {
                doc(selectors[s]).each(function(i, el) {
                    var src = el.attr('src') || el.attr('data-src') || '';
                    if (src && src.length > 10) {
                        if (src.indexOf('http') !== 0 && src.indexOf('//') === 0) { src = 'https:' + src; }
                        else if (src.indexOf('http') !== 0) { src = 'https://astral-manga.fr' + (src.indexOf('/') === 0 ? '' : '/') + src; }
                        pages.push({ url: src, index: pages.length, headers: { 'Referer': url, 'User-Agent': userAgent } });
                    }
                });
                if (pages.length > 0) break;
            }

            // Fallback: all images
            if (pages.length === 0) {
                doc('img').each(function(i, el) {
                    var src = el.attr('src') || el.attr('data-src') || '';
                    if (src && src.length > 10 && (src.indexOf('.jpg') > 0 || src.indexOf('.png') > 0 || src.indexOf('.webp') > 0)) {
                        if (src.indexOf('http') !== 0 && src.indexOf('//') === 0) { src = 'https:' + src; }
                        else if (src.indexOf('http') !== 0) { src = 'https://astral-manga.fr' + (src.indexOf('/') === 0 ? '' : '/') + src; }
                        pages.push({ url: src, index: pages.length, headers: { 'Referer': url, 'User-Agent': userAgent } });
                    }
                });
            }

            // Try to extract from RSC (Next.js)
            if (pages.length === 0) {
                var rsc = this._parseRSC(html);
                if (rsc) {
                    var images = this._findAllImages(rsc, []);
                    for (var i2 = 0; i2 < images.length; i2++) {
                        var imgUrl = images[i2].link || '';
                        if (imgUrl.indexOf('s3:') === 0) { imgUrl = this.api + '/api/s3/presign-get?key=' + encodeURIComponent(imgUrl.substring(3)); }
                        else if (imgUrl.indexOf('http') !== 0) { imgUrl = this.api + imgUrl; }
                        pages.push({ url: imgUrl, index: pages.length, headers: { 'Referer': url, 'User-Agent': userAgent } });
                    }
                }
            }

            console.log('[astral] found', pages.length, 'pages for', chapterUuid);
            return pages;
        } catch (e) {
            console.error('[astral] pages error:', e.message || e);
            return [];
        }
    }

    // =================================================================
    //  RSC Parser (Next.js React Server Components)
    // =================================================================

    _parseRSC(text) {
        var pushRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
        var combined = '';
        var m;
        while ((m = pushRegex.exec(text)) !== null) {
            combined += m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '').replace(/\\t/g, '');
        }
        if (!combined) return null;
        try { return JSON.parse(combined); } catch (e) {
            var lines = combined.split('\n');
            for (var i = 0; i < lines.length; i++) {
                if (!lines[i]) continue;
                try {
                    var obj = JSON.parse(lines[i]);
                    if (typeof obj === 'object' && obj !== null) return obj;
                } catch (e2) {}
            }
        }
        return null;
    }

    _findAllChapters(node, mangaId, found) {
        if (!found) found = [];
        if (!node || typeof node !== 'object') return found;
        if (typeof node.id === 'string' && typeof node.orderId === 'number' && typeof node.mangaId === 'string') {
            if (node.mangaId === mangaId || !mangaId) {
                var dup = false;
                for (var i = 0; i < found.length; i++) { if (found[i].id === node.id) { dup = true; break; } }
                if (!dup) found.push(node);
            }
        }
        if (Array.isArray(node)) { for (var j = 0; j < node.length; j++) this._findAllChapters(node[j], mangaId, found); }
        else if (typeof node === 'object') { for (var k in node) { if (k !== '__proto__' && k !== 'constructor') this._findAllChapters(node[k], mangaId, found); } }
        return found;
    }

    _findAllImages(node, found) {
        if (!found) found = [];
        if (!node || typeof node !== 'object') return found;
        if (typeof node.link === 'string' && typeof node.orderId === 'number') {
            var dup = false;
            for (var i = 0; i < found.length; i++) { if (found[i].link === node.link) { dup = true; break; } }
            if (!dup) found.push({ link: node.link, orderId: node.orderId });
        }
        if (Array.isArray(node)) { for (var j = 0; j < node.length; j++) this._findAllImages(node[j], found); }
        else if (typeof node === 'object') { for (var k in node) { if (k !== '__proto__' && k !== 'constructor') this._findAllImages(node[k], found); } }
        return found;
    }
}
