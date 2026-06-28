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
 *
 * Cloudflare bypass: the site is behind Cloudflare. We warm up the session
 * by visiting the homepage first, which triggers the JS challenge in Electron's
 * Chromium engine and sets the cf_clearance cookie for all subsequent requests.
 */

class Provider {
    constructor() {
        this.api = 'https://astral-manga.fr';
        this._warmedUp = false;
        this._warmingUp = null;
    }

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        };
    }

    // =================================================================
    //  Cloudflare warmup
    // =================================================================

    /**
     * Visit the homepage to trigger Cloudflare's JS challenge.
     * In Electron, the JS challenge runs in the Chromium engine and sets
     * cf_clearance. If fetch() shares the Electron cookie jar, subsequent
     * API calls will pass through Cloudflare.
     *
     * If fetch() does NOT share cookies (Goja polyfill), this won't help
     * and we fall back to scraping the search page HTML.
     */
    async _warmup() {
        if (this._warmedUp) return;
        if (this._warmingUp) return this._warmingUp;

        this._warmingUp = (async () => {
            try {
                console.log('[astral] Warmup: visiting homepage to solve Cloudflare challenge...');

                // Step 1: hit the homepage
                var homeRes = await fetch(this.api + '/', {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
                    },
                });

                console.log('[astral] Warmup: homepage status ' + homeRes.status);
                var homeText = await homeRes.text();

                var isChallenge = homeText.indexOf('Just a moment') !== -1 ||
                                  homeText.indexOf('challenge-platform') !== -1 ||
                                  homeText.indexOf('cf-browser-verification') !== -1;

                if (isChallenge) {
                    console.log('[astral] Warmup: Cloudflare challenge detected, waiting 5s for JS to solve...');
                    // The challenge JS runs automatically in Electron's Chromium.
                    // Give it time to complete.
                    await new Promise(function (resolve) {
                        setTimeout(resolve, 5000);
                    });

                    // Retry — if cookies are shared, this should go through
                    var retryRes = await fetch(this.api + '/', {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
                        },
                    });
                    var retryText = await retryRes.text();
                    console.log('[astral] Warmup: retry status ' + retryRes.status);

                    if (retryText.indexOf('Just a moment') !== -1 || retryRes.status === 403) {
                        console.warn('[astral] Warmup: STILL BLOCKED after retry — fetch() may not share Electron cookies');
                    } else {
                        console.log('[astral] Warmup: challenge solved ✓');
                        this._cfCookiesWork = true;
                    }
                } else if (homeRes.status === 200 && homeText.indexOf('<html') !== -1) {
                    console.log('[astral] Warmup: got homepage directly (no challenge) ✓');
                    this._cfCookiesWork = true;
                } else {
                    console.log('[astral] Warmup: homepage returned status ' + homeRes.status + ' (unexpected, but continuing)');
                }
            } catch (e) {
                console.warn('[astral] Warmup: error — ' + (e.message || e));
            }
            this._warmedUp = true;
        })();

        return this._warmingUp;
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

        if (!q) {
            return [];
        }

        // Warm up Cloudflare session first
        await this._warmup();

        var searchUrl = this.api + '/api/mangas' +
            '?query=' + encodeURIComponent(q) +
            '&page=1' +
            '&pageSize=12' +
            '&sortBy=title' +
            '&sortOrder=asc' +
            '&includeMode=and' +
            '&excludeMode=or';

        try {
            var res = await this._fetch(searchUrl);

            if (!res.ok) {
                return [];
            }

            var text = await res.text();

            // Check for Cloudflare block (even after warmup)
            if (text.indexOf('Just a moment') !== -1) {
                // Retry warmup once
                this._warmedUp = false;
                await this._warmup();
                var retryRes = await this._fetch(searchUrl);
                if (!retryRes.ok) return [];
                text = await retryRes.text();
                if (text.indexOf('Just a moment') !== -1) return [];
            }

            // Check for HTML (RSC or regular page) instead of JSON
            if (text.indexOf('{') !== 0 && text.indexOf('[') !== 0) {
                // Try RSC parsing as fallback
                var rscParsed = this.parseRSC(text);
                if (rscParsed) {
                    var foundMangas = this._findAllMangas(rscParsed);
                    if (foundMangas.length > 0) {
                        return foundMangas;
                    }
                }
                return [];
            }

            var json = JSON.parse(text);

            if (!json.mangas || !Array.isArray(json.mangas)) {
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

            return results;
        } catch (e) {
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
        if (!this.isUUID(seriesId)) {
            return [];
        }

        // Warm up Cloudflare session first
        await this._warmup();

        try {
            var res = await this._fetch(this.api + '/manga/' + seriesId, {
                'RSC': '1'
            });

            if (!res.ok) {
                return [];
            }

            var html = await res.text();

            // Check for Cloudflare block
            if (html.indexOf('Just a moment') !== -1) {
                return [];
            }

            var parsed = this.parseRSC(html);
            if (!parsed) {
                return [];
            }

            var mangaObj = this._findBySignature(parsed, 'manga');
            var mangaData = mangaObj ? mangaObj.data : parsed;
            var mangaInternalId = '';
            if (mangaData && mangaData.id) {
                mangaInternalId = mangaData.id;
            }

            var chapterNodes = this._findAllChapters(parsed, mangaInternalId);

            if (chapterNodes.length === 0) {
                // Retry with cache-bust
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

            return chapters;
        } catch (e) {
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
        // Warm up Cloudflare session first
        await this._warmup();

        try {
            var parts = chapterId.split('|');
            if (parts.length !== 2) {
                return [];
            }

            var mangaId = parts[0];
            var chId = parts[1];

            var url = this.api + '/manga/' + mangaId + '/chapter/' + chId;

            var res = await this._fetch(url);

            if (!res.ok) {
                return [];
            }

            var html = await res.text();

            // Check for Cloudflare block
            if (html.indexOf('Just a moment') !== -1) {
                return [];
            }

            // Strategy 1: Parse RSC data for RscImageDto objects
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
                        pages.push({
                            url: imgUrl,
                            index: i,
                            headers: { 'Referer': url },
                        });
                    }
                    return pages;
                }
            }

            // Strategy 2: Regex for s3: keys in the HTML
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
                    pages2.push({
                        url: this.resolveImage(keys[p]),
                        index: p,
                        headers: { 'Referer': url },
                    });
                }
                return pages2;
            }

            // Strategy 3: <img alt~=^Page \d+> elements
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
                return pages3;
            }

            return [];
        } catch (e) {
            return [];
        }
    }
}
