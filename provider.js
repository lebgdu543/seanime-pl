/// <reference path="./manga-provider.d.ts" />

/**
 * Seanime Manga Provider for Astral-Manga.fr
 *
 * French manga/manhwa scanlation site (Next.js App Router)
 *
 * API endpoints (from working Tachiyomi extension):
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
    //  Helpers
    // =================================================================

    /**
     * Fetch with browser-mimicking headers + X-Requested-With (helps with some CF configs).
     */
    async _fetch(url, extraHeaders) {
        var headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': this.api + '/',
            'X-Requested-With': 'XMLHttpRequest',
        };

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
     * Handles: "s3:uploads/projects/..." or "uploads/projects/..."
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
            // Try line-by-line
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

        // Manga: has "title" string AND "chapters" array
        if (!type || type === 'manga') {
            if (typeof node.title === 'string' && Array.isArray(node.chapters)) {
                return { type: 'manga', data: node };
            }
        }

        // Chapter: has "id" string AND "images" array (but NOT "chapters")
        if (!type || type === 'chapter') {
            if (typeof node.id === 'string' && Array.isArray(node.images) && !Array.isArray(node.chapters)) {
                return { type: 'chapter', data: node };
            }
        }

        // RSC image with orderId
        if (type === 'image') {
            if (typeof node.link === 'string' && typeof node.orderId === 'number') {
                return { type: 'image', data: node };
            }
        }

        // Recurse
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

    /**
     * Search via the /api/mangas REST endpoint (same as Tachiyomi extension).
     *
     * API returns: { mangas: [{ id, title, urlId, cover: { image: { link } } }], total: N }
     */
    async search(opts) {
        var q = (opts.query || '').trim();
        console.log('[astral] search() called with query:', JSON.stringify(q));

        if (!q) {
            console.log('[astral] search: empty query, returning []');
            return [];
        }

        var searchUrl = this.api + '/api/mangas' +
            '?query=' + encodeURIComponent(q) +
            '&page=1' +
            '&pageSize=12' +
            '&sortBy=title' +
            '&sortOrder=asc' +
            '&includeMode=and' +
            '&excludeMode=or';

        console.log('[astral] search URL:', searchUrl);

        try {
            var res = await this._fetch(searchUrl);
            console.log('[astral] search HTTP status:', res.status);

            if (!res.ok) {
                console.warn('[astral] search: HTTP error', res.status);
                return [];
            }

            var text = await res.text();
            console.log('[astral] search response length:', text.length);

            // Check for Cloudflare block
            if (text.indexOf('Just a moment') !== -1) {
                console.error('[astral] search: Cloudflare challenge page returned!');
                return [];
            }

            // Check for HTML (RSC or regular page) instead of JSON
            if (text.indexOf('{') !== 0 && text.indexOf('[') !== 0) {
                console.warn('[astral] search: response is not JSON, trying RSC parse...');
                // Try RSC parsing as fallback
                var rscParsed = this.parseRSC(text);
                if (rscParsed) {
                    console.log('[astral] search: RSC parsed successfully, walking tree...');
                    // Walk the tree for manga-like objects
                    var foundMangas = this._findAllMangas(rscParsed);
                    console.log('[astral] search: found', foundMangas.length, 'mangas in RSC tree');
                    if (foundMangas.length > 0) {
                        return foundMangas;
                    }
                }
                return [];
            }

            var json = JSON.parse(text);
            console.log('[astral] search JSON keys:', Object.keys(json).join(', '));
            console.log('[astral] search total:', json.total, 'mangas:', json.mangas ? json.mangas.length : 'missing');

            if (!json.mangas || !Array.isArray(json.mangas)) {
                console.warn('[astral] search: no mangas array in response');
                return [];
            }

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

            console.log('[astral] search: returning', results.length, 'results');
            return results;
        } catch (e) {
            console.error('[astral] search exception:', e.message || e);
            return [];
        }
    }

    /**
     * Find ALL manga-like objects in RSC tree (for search fallback).
     */
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

    /**
     * Get chapters for a manga via RSC header.
     */
    async findChapters(seriesId) {
        console.log('[astral] findChapters called with:', seriesId);

        if (!this.isUUID(seriesId)) {
            console.warn('[astral] findChapters: not a UUID, returning [] (got AniList ID?)');
            return [];
        }

        try {
            var res = await this._fetch(this.api + '/manga/' + seriesId, {
                'RSC': '1'
            });

            console.log('[astral] findChapters HTTP:', res.status);

            if (!res.ok) {
                console.warn('[astral] findChapters: HTTP error', res.status);
                return [];
            }

            var html = await res.text();
            console.log('[astral] findChapters response length:', html.length);

            // Check for Cloudflare block
            if (html.indexOf('Just a moment') !== -1) {
                console.error('[astral] findChapters: Cloudflare challenge page!');
                return [];
            }

            var parsed = this.parseRSC(html);
            if (!parsed) {
                console.warn('[astral] findChapters: RSC parse returned null');
                return [];
            }

            var mangaObj = this._findBySignature(parsed, 'manga');
            var mangaData = mangaObj ? mangaObj.data : parsed;
            var mangaInternalId = '';
            if (mangaData && mangaData.id) {
                mangaInternalId = mangaData.id;
            }

            var chapterNodes = this._findAllChapters(parsed, mangaInternalId);
            console.log('[astral] findChapters: found', chapterNodes.length, 'chapter nodes');

            if (chapterNodes.length === 0) {
                console.log('[astral] findChapters: retrying with cache-bust...');
                var retryUrl = this.api + '/manga/' + seriesId + '?_=' + Date.now();
                var retryRes = await this._fetch(retryUrl, {
                    'RSC': '1',
                    'Cache-Control': 'no-cache'
                });

                if (retryRes.ok) {
                    var retryHtml = await retryRes.text();
                    var retryParsed = this.parseRSC(retryHtml);
                    if (retryParsed) {
                        chapterNodes = this._findAllChapters(retryParsed, mangaInternalId);
                        console.log('[astral] findChapters: retry found', chapterNodes.length, 'chapter nodes');
                    }
                }
            }

            var chapters = [];
            for (var i = 0; i < chapterNodes.length; i++) {
                var ch = chapterNodes[i];
                var num = ch.orderId;
                var numStr;
                if (num % 1 === 0) {
                    numStr = String(Math.floor(num));
                } else {
                    numStr = String(num);
                }

                // Composite ID: urlId|chapterUuid
                var compositeId = seriesId + '|' + ch.id;

                chapters.push({
                    id: compositeId,
                    url: '/manga/' + seriesId + '/chapter/' + ch.id,
                    title: 'Chapitre ' + numStr,
                    chapter: numStr,
                    index: i,
                });
            }

            // Sort by chapter number descending (newest first)
            chapters.sort(function (a, b) {
                var aNum = parseFloat(a.chapter);
                var bNum = parseFloat(b.chapter);
                return bNum - aNum;
            });

            // Re-index after sort
            for (var j = 0; j < chapters.length; j++) {
                chapters[j].index = j;
            }

            console.log('[astral] findChapters: returning', chapters.length, 'chapters');
            return chapters;
        } catch (e) {
            console.error('[astral] findChapters exception:', e.message || e);
            return [];
        }
    }

    /**
     * Get page images for a chapter.
     *
     * Strategy 1: RSC data for image objects with link + orderId
     * Strategy 2: Regex for s3: keys in the HTML
     * Strategy 3: <img alt~=^Page \d+> elements
     */
    async findChapterPages(chapterId) {
        console.log('[astral] findChapterPages called with:', chapterId);

        try {
            var parts = chapterId.split('|');
            if (parts.length !== 2) {
                console.warn('[astral] findChapterPages: invalid chapter ID format');
                return [];
            }

            var mangaId = parts[0];
            var chId = parts[1];

            var url = this.api + '/manga/' + mangaId + '/chapter/' + chId;
            console.log('[astral] findChapterPages URL:', url);

            var res = await this._fetch(url);
            console.log('[astral] findChapterPages HTTP:', res.status);

            if (!res.ok) {
                console.warn('[astral] findChapterPages: HTTP error', res.status);
                return [];
            }

            var html = await res.text();
            console.log('[astral] findChapterPages response length:', html.length);

            // Check for Cloudflare block
            if (html.indexOf('Just a moment') !== -1) {
                console.error('[astral] findChapterPages: Cloudflare challenge page!');
                return [];
            }

            // Strategy 1: Parse RSC data for RscImageDto objects
            var parsed = this.parseRSC(html);
            if (parsed) {
                var images = this._findAllImages(parsed);
                console.log('[astral] findChapterPages: RSC images found:', images.length);
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
                        pages.push({
                            url: imgUrl,
                            index: i,
                            headers: { 'Referer': url },
                        });
                    }
                    console.log('[astral] findChapterPages: returning', pages.length, 'RSC pages');
                    return pages;
                }
            }

            // Strategy 2: Regex for s3: keys in the HTML
            var s3KeyRegex = /s3:uploads\/projects\/[a-f0-9-]{36}\/chapters\/[a-f0-9-]{36}\/[^"'\s,}\]]+/g;
            var s3Keys = html.match(s3KeyRegex);
            console.log('[astral] findChapterPages: s3 regex matches:', s3Keys ? s3Keys.length : 0);
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
                    pages2.push({
                        url: this.resolveImage(keys[p]),
                        index: p,
                        headers: { 'Referer': url },
                    });
                }
                console.log('[astral] findChapterPages: returning', pages2.length, 's3 pages');
                return pages2;
            }

            // Strategy 3: <img alt~=^Page \d+> elements
            var imgRegex = /<img[^>]*alt="Page \d+"[^>]*src="([^"]+)"/gi;
            var imgMatches = html.match(imgRegex);
            console.log('[astral] findChapterPages: img tag matches:', imgMatches ? imgMatches.length : 0);
            if (imgMatches && imgMatches.length > 0) {
                var srcRegex = /src="([^"]+)"/i;
                var pages3 = [];
                var idx = 0;
                for (var m = 0; m < imgMatches.length; m++) {
                    var srcMatch = srcRegex.exec(imgMatches[m]);
                    if (srcMatch && srcMatch[1]) {
                        var src = srcMatch[1];
                        if (src.indexOf('http') !== 0) {
                            src = this.api + src;
                        }
                        pages3.push({
                            url: src,
                            index: idx,
                            headers: { 'Referer': url },
                        });
                        idx++;
                    }
                }
                console.log('[astral] findChapterPages: returning', pages3.length, 'img pages');
                return pages3;
            }

            console.warn('[astral] findChapterPages: no pages found with any strategy');
            return [];
        } catch (e) {
            console.error('[astral] findChapterPages exception:', e.message || e);
            return [];
        }
    }
}
