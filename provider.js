/// <reference path="./manga-provider.d.ts" />

/**
 * Seanime Manga Provider for Astral-Manga.fr
 *
 * French manga/manhwa scanlation site (Next.js App Router)
 *
 * Requires the "Astral-Manga Bridge" tray plugin to be installed.
 * The plugin uses Seanime's built-in Cloudflare bypass to obtain
 * cf_clearance cookies and stores them in $store.
 * This provider reads those cookies and includes them in API requests.
 *
 * Without the bridge plugin, Cloudflare will block all API calls.
 *
 * API endpoints:
 *   Search:  GET /api/mangas?query=...&page=1&pageSize=20
 *   Manga:   GET /manga/{urlId}  (RSC: 1 header for chapter list)
 *   Chapter: GET /manga/{urlId}/chapter/{chapterUuid}
 *   Images:  GET /api/s3/presign-get?key=...
 */

class Provider {
    constructor() {
        this.api = 'https://astral-manga.fr';
    }

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        };
    }

    // =================================================================
    //  Cloudflare cookie bridge
    // =================================================================

    /**
     * Read cf_clearance cookies from $store (set by the astral-bridge tray plugin).
     * Returns a Cookie header string, or empty string if no cookies available.
     */
    _getCookieHeader() {
        try {
            var cookies = $store.get('astral-manga-cookies');
            if (cookies && cookies.cf_clearance) {
                var parts = ['cf_clearance=' + cookies.cf_clearance];
                if (cookies.__cf_bm) {
                    parts.push('__cf_bm=' + cookies.__cf_bm);
                }
                console.log('[astral] Using stored Cloudflare cookies (age: ' +
                    Math.round((Date.now() - cookies.refreshedAt) / 60000) + 'min)');
                return parts.join('; ');
            }
        } catch (e) {
            // $store might not be available in older Seanime versions
            console.warn('[astral] $store not available. Install the Astral-Manga Bridge plugin.');
        }
        return '';
    }

    /**
     * Check if we have valid cookies and warn if not.
     */
    _checkBridge() {
        if (typeof this._bridgeWarned !== 'undefined') return this._hasCookies;

        var cookies = this._getCookieHeader();
        if (!cookies) {
            console.warn('[astral] ┌─────────────────────────────────────────────┐');
            console.warn('[astral] │  PLUGIN REQUIRED                             │');
            console.warn('[astral] │  Install the "Astral-Manga Bridge" tray      │');
            console.warn('[astral] │  plugin to bypass Cloudflare protection.     │');
            console.warn('[astral] │  Without it, all API calls will get 403.     │');
            console.warn('[astral] │  Check the plugin tray icon for status.      │');
            console.warn('[astral] └─────────────────────────────────────────────┘');
            this._hasCookies = false;
            this._bridgeWarned = true;
        } else {
            this._hasCookies = true;
            this._bridgeWarned = true;
        }

        return this._hasCookies;
    }

    // =================================================================
    //  Helpers
    // =================================================================

    /**
     * Fetch with browser-mimicking headers + Cloudflare cookies.
     */
    async _fetch(url, extraHeaders) {
        var headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': this.api + '/',
            'X-Requested-With': 'XMLHttpRequest',
        };

        // Inject Cloudflare clearance cookies from the bridge plugin
        var cookieHeader = this._getCookieHeader();
        if (cookieHeader) {
            headers['Cookie'] = cookieHeader;
        }

        if (extraHeaders) {
            var keys = Object.keys(extraHeaders);
            for (var i = 0; i < keys.length; i++) {
                headers[keys[i]] = extraHeaders[keys[i]];
            }
        }

        return fetch(url, { headers: headers });
    }

    /**
     * Resolve an S3 key to a presigned URL.
     */
    resolveImage(s3Key) {
        var raw = s3Key;
        if (raw.indexOf('s3:') === 0) {
            raw = raw.substring(3);
        }
        return this.api + '/api/s3/presign-get?key=' + encodeURIComponent(raw);
    }

    /**
     * Check if a string looks like an Astral UUID (36-char hex with dashes).
     */
    isUUID(str) {
        return !!(str && str.length === 36 && str.indexOf('-') !== -1);
    }

    /**
     * Parse React Server Components wire format from HTML.
     */
    parseRSC(text) {
        var pushRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
        var combined = '';
        var m;
        while ((m = pushRegex.exec(text)) !== null) {
            combined += m[1]
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
                .replace(/\\n/g, '')
                .replace(/\\t/g, '');
        }

        if (!combined) return null;

        try {
            return JSON.parse(combined);
        } catch (e) {
            var lines = combined.split('\n');
            for (var i = 0; i < lines.length; i++) {
                if (!lines[i]) continue;
                try {
                    var obj = JSON.parse(lines[i]);
                    if (typeof obj === 'object' && obj !== null) {
                        var found = this._findBySignature(obj);
                        if (found) return found;
                    }
                } catch (e2) { /* continue */ }
            }
        }

        return null;
    }

    /**
     * Walk parsed object tree looking for manga/chapter data.
     */
    _findBySignature(node, type) {
        if (!node || typeof node !== 'object') return null;

        if (!type || type === 'manga') {
            if (typeof node.title === 'string' && Array.isArray(node.chapters)) {
                return { type: 'manga', data: node };
            }
        }

        if (!type || type === 'chapter') {
            if (typeof node.id === 'string' && Array.isArray(node.images) && !Array.isArray(node.chapters)) {
                return { type: 'chapter', data: node };
            }
        }

        if (type === 'image') {
            if (typeof node.link === 'string' && typeof node.orderId === 'number') {
                return { type: 'image', data: node };
            }
        }

        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) {
                var found = this._findBySignature(node[i], type);
                if (found) return found;
            }
        } else if (typeof node === 'object') {
            var keys = Object.keys(node);
            for (var j = 0; j < keys.length; j++) {
                var key = keys[j];
                if (key === '__proto__' || key === 'constructor') continue;
                var found = this._findBySignature(node[key], type);
                if (found) return found;
            }
        }

        return null;
    }

    /**
     * Walk RSC tree to find ALL chapter objects.
     */
    _findAllChapters(node, mangaId, found) {
        if (!found) found = [];
        if (!node || typeof node !== 'object') return found;

        if (typeof node.id === 'string' && typeof node.orderId === 'number' && typeof node.mangaId === 'string') {
            if (node.mangaId === mangaId || !mangaId) {
                var dup = false;
                for (var i = 0; i < found.length; i++) {
                    if (found[i].id === node.id) { dup = true; break; }
                }
                if (!dup) found.push(node);
            }
        }

        if (Array.isArray(node)) {
            for (var j = 0; j < node.length; j++) {
                this._findAllChapters(node[j], mangaId, found);
            }
        } else if (typeof node === 'object') {
            var keys = Object.keys(node);
            for (var k = 0; k < keys.length; k++) {
                var key = keys[k];
                if (key === '__proto__' || key === 'constructor') continue;
                this._findAllChapters(node[key], mangaId, found);
            }
        }

        return found;
    }

    /**
     * Walk RSC tree to find ALL image objects.
     */
    _findAllImages(node, found) {
        if (!found) found = [];
        if (!node || typeof node !== 'object') return found;

        if (typeof node.link === 'string' && typeof node.orderId === 'number') {
            var dup = false;
            for (var i = 0; i < found.length; i++) {
                if (found[i].link === node.link) { dup = true; break; }
            }
            if (!dup) found.push({ link: node.link, orderId: node.orderId });
        }

        if (Array.isArray(node)) {
            for (var j = 0; j < node.length; j++) {
                this._findAllImages(node[j], found);
            }
        } else if (typeof node === 'object') {
            var keys = Object.keys(node);
            for (var k = 0; k < keys.length; k++) {
                var key = keys[k];
                if (key === '__proto__' || key === 'constructor') continue;
                this._findAllImages(node[key], found);
            }
        }

        return found;
    }

    // =================================================================
    //  Provider Interface
    // =================================================================

    async search(opts) {
        var q = (opts.query || '').trim();
        if (!q) return [];

        this._checkBridge();

        var searchUrl = this.api + '/api/mangas' +
            '?query=' + encodeURIComponent(q) +
            '&page=1&pageSize=12&sortBy=title&sortOrder=asc' +
            '&includeMode=and&excludeMode=or';

        try {
            var res = await this._fetch(searchUrl);
            if (!res.ok) {
                if (res.status === 403) {
                    console.warn('[astral] search: 403 Forbidden — bridge plugin may need refresh');
                }
                return [];
            }

            var text = await res.text();

            if (text.indexOf('Just a moment') !== -1) {
                console.warn('[astral] search: Cloudflare block. Click the bridge plugin tray icon to refresh.');
                return [];
            }

            if (text.indexOf('{') !== 0 && text.indexOf('[') !== 0) {
                var rscParsed = this.parseRSC(text);
                if (rscParsed) {
                    var foundMangas = this._findAllMangas(rscParsed);
                    if (foundMangas.length > 0) return foundMangas;
                }
                return [];
            }

            var json = JSON.parse(text);
            if (!json.mangas || !Array.isArray(json.mangas)) return [];

            var results = [];
            for (var i = 0; i < json.mangas.length; i++) {
                var m = json.mangas[i];
                var img;
                if (m.cover && m.cover.image && m.cover.image.link) {
                    img = this.resolveImage(m.cover.image.link);
                }
                results.push({
                    id: m.urlId || m.id || '',
                    title: m.title || '',
                    image: img,
                });
            }
            return results;
        } catch (e) {
            return [];
        }
    }

    _findAllMangas(node, found) {
        if (!found) found = [];
        if (!node || typeof node !== 'object') return found;

        if (typeof node.title === 'string' && typeof node.urlId === 'string') {
            var dup = false;
            for (var i = 0; i < found.length; i++) {
                if (found[i].id === node.urlId) { dup = true; break; }
            }
            if (!dup && node.title.trim()) {
                var img;
                if (node.cover && node.cover.image && node.cover.image.link) {
                    img = this.resolveImage(node.cover.image.link);
                }
                found.push({
                    id: node.urlId,
                    title: node.title,
                    image: img,
                });
            }
        }

        if (Array.isArray(node)) {
            for (var j = 0; j < node.length; j++) {
                this._findAllMangas(node[j], found);
            }
        } else if (typeof node === 'object') {
            var keys = Object.keys(node);
            for (var k = 0; k < keys.length; k++) {
                var key = keys[k];
                if (key === '__proto__' || key === 'constructor') continue;
                this._findAllMangas(node[key], found);
            }
        }

        return found;
    }

    async findChapters(seriesId) {
        if (!this.isUUID(seriesId)) return [];

        this._checkBridge();

        try {
            var res = await this._fetch(this.api + '/manga/' + seriesId, { 'RSC': '1' });
            if (!res.ok) return [];

            var html = await res.text();
            if (html.indexOf('Just a moment') !== -1) return [];

            var parsed = this.parseRSC(html);
            if (!parsed) return [];

            var mangaObj = this._findBySignature(parsed, 'manga');
            var mangaData = mangaObj ? mangaObj.data : parsed;
            var mangaInternalId = '';
            if (mangaData && mangaData.id) mangaInternalId = mangaData.id;

            var chapterNodes = this._findAllChapters(parsed, mangaInternalId);

            if (chapterNodes.length === 0) {
                var retryRes = await this._fetch(
                    this.api + '/manga/' + seriesId + '?_=' + Date.now(),
                    { 'RSC': '1', 'Cache-Control': 'no-cache' }
                );
                if (retryRes.ok) {
                    var retryHtml = await retryRes.text();
                    var retryParsed = this.parseRSC(retryHtml);
                    if (retryParsed) chapterNodes = this._findAllChapters(retryParsed, mangaInternalId);
                }
            }

            var chapters = [];
            for (var i = 0; i < chapterNodes.length; i++) {
                var ch = chapterNodes[i];
                var num = ch.orderId;
                var numStr = (num % 1 === 0) ? String(Math.floor(num)) : String(num);
                chapters.push({
                    id: seriesId + '|' + ch.id,
                    url: '/manga/' + seriesId + '/chapter/' + ch.id,
                    title: 'Chapitre ' + numStr,
                    chapter: numStr,
                    index: i,
                });
            }

            chapters.sort(function (a, b) {
                return parseFloat(b.chapter) - parseFloat(a.chapter);
            });
            for (var j = 0; j < chapters.length; j++) chapters[j].index = j;

            return chapters;
        } catch (e) {
            return [];
        }
    }

    async findChapterPages(chapterId) {
        this._checkBridge();

        try {
            var parts = chapterId.split('|');
            if (parts.length !== 2) return [];

            var mangaId = parts[0];
            var chId = parts[1];
            var url = this.api + '/manga/' + mangaId + '/chapter/' + chId;

            var res = await this._fetch(url);
            if (!res.ok) return [];

            var html = await res.text();
            if (html.indexOf('Just a moment') !== -1) return [];

            // Strategy 1: RSC image objects
            var parsed = this.parseRSC(html);
            if (parsed) {
                var images = this._findAllImages(parsed);
                if (images.length > 0) {
                    images.sort(function (a, b) { return a.orderId - b.orderId; });
                    var pages = [];
                    for (var i = 0; i < images.length; i++) {
                        var imgUrl;
                        if (images[i].link.indexOf('s3:') === 0) {
                            imgUrl = this.resolveImage(images[i].link);
                        } else if (images[i].link.indexOf('http') === 0) {
                            imgUrl = images[i].link;
                        } else {
                            imgUrl = this.api + images[i].link;
                        }
                        pages.push({ url: imgUrl, index: i, headers: { 'Referer': url } });
                    }
                    return pages;
                }
            }

            // Strategy 2: s3: keys in HTML
            var s3KeyRegex = /s3:uploads\/projects\/[a-f0-9-]{36}\/chapters\/[a-f0-9-]{36}\/[^"'\s,}\]]+/g;
            var s3Keys = html.match(s3KeyRegex);
            if (s3Keys && s3Keys.length > 0) {
                var pageKeys = [];
                for (var k = 0; k < s3Keys.length; k++) {
                    if (s3Keys[k].indexOf('/cover') === -1 && s3Keys[k].indexOf('cover-') === -1) {
                        pageKeys.push(s3Keys[k]);
                    }
                }
                var keys = pageKeys.length > 0 ? pageKeys : s3Keys;
                var pages2 = [];
                for (var p = 0; p < keys.length; p++) {
                    pages2.push({ url: this.resolveImage(keys[p]), index: p, headers: { 'Referer': url } });
                }
                return pages2;
            }

            // Strategy 3: <img alt="Page N"> elements
            var imgRegex = /<img[^>]*alt="Page \d+"[^>]*src="([^"]+)"/gi;
            var imgMatches = html.match(imgRegex);
            if (imgMatches && imgMatches.length > 0) {
                var srcRegex = /src="([^"]+)"/i;
                var pages3 = [];
                var idx = 0;
                for (var m = 0; m < imgMatches.length; m++) {
                    var srcMatch = srcRegex.exec(imgMatches[m]);
                    if (srcMatch && srcMatch[1]) {
                        var src = srcMatch[1];
                        if (src.indexOf('http') !== 0) src = this.api + src;
                        pages3.push({ url: src, index: idx, headers: { 'Referer': url } });
                        idx++;
                    }
                }
                return pages3;
            }

            return [];
        } catch (e) {
            return [];
        }
    }
}
