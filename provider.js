/// <reference path="./manga-provider.d.ts" />

/**
 * Seanime Manga Provider for Astral-Manga.fr
 *
 * Site: French manga/manhwa scanlation (Next.js App Router)
 *
 * API endpoints (discovered from working Tachiyomi extension):
 *   Search:  GET /api/mangas?query=...&page=1&pageSize=20
 *   Manga:   GET /manga/{urlId}  (RSC: 1 header for details)
 *   Chapter: GET /manga/{urlId}/chapter/{chapterUuid}
 *   Images:  GET /api/s3/presign-get?key=...
 */

class Provider {
    api;

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
     * Resolve an S3 key to a presigned URL.
     * Handles: "s3:uploads/projects/...", "uploads/projects/...", or already-presigned URLs
     */
    resolveImage(s3Key) {
        var raw = s3Key;
        if (raw.indexOf('s3:') === 0) {
            raw = raw.substring(3);
        }
        return this.api + '/api/s3/presign-get?key=' + encodeURIComponent(raw);
    }

    /**
     * Fetch helper with browser-mimicking headers to pass Cloudflare.
     */
    async _fetch(url, extraHeaders) {
        var headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': this.api + '/',
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
     * Parse React Server Components wire format from HTML.
     * Extracts all self.__next_f.push([1,"..."]) chunks, unescapes them,
     * and tries to parse a JSON tree.
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
     * Walk a parsed object tree looking for manga or chapter data.
     */
    _findBySignature(node, type) {
        if (!node || typeof node !== 'object') return null;

        // Manga signature: has "title" string AND "chapters" array
        if (!type || type === 'manga') {
            if (typeof node.title === 'string' && Array.isArray(node.chapters)) {
                return { type: 'manga', data: node };
            }
        }

        // Chapter signature: has "id" string AND "images" array (but NOT "chapters")
        if (!type || type === 'chapter') {
            if (typeof node.id === 'string' && Array.isArray(node.images) && !Array.isArray(node.chapters)) {
                return { type: 'chapter', data: node };
            }
        }

        // RSC image with orderId (for image extraction)
        if (type === 'image') {
            if (typeof node.link === 'string' && typeof node.orderId === 'number') {
                return { type: 'image', data: node };
            }
        }

        // Recurse into arrays
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
     * Walk parsed RSC data to find ALL chapter objects (not just the first).
     * Returns array of { id, orderId, publishDate, mangaId }.
     */
    _findAllChapters(node, mangaId, found) {
        if (!found) found = [];
        if (!node || typeof node !== 'object') return found;

        if (typeof node.id === 'string' && typeof node.orderId === 'number' && typeof node.mangaId === 'string') {
            if (node.mangaId === mangaId || !mangaId) {
                // Deduplicate by id
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
     * Check if a string looks like an Astral UUID (36-char hex with dashes).
     * Non-UUID values are likely AniList IDs.
     */
    isUUID(str) {
        return str && str.length === 36 && str.indexOf('-') !== -1;
    }

    // =================================================================
    //  Provider Interface
    // =================================================================

    /**
     * Search for manga via the /api/mangas REST endpoint.
     *
     * The API returns JSON:
     *   { mangas: [{ id, title, urlId, cover: { image: { link } } }], total: N }
     */
    async search(opts) {
        var q = (opts.query || '').trim();
        if (!q) return [];

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

            if (!res.ok) return [];

            var json = await res.json();

            if (!json || !json.mangas || !Array.isArray(json.mangas)) return [];

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
     * Get chapters for a manga.
     *
     * Uses RSC: 1 header to get structured data from the manga page,
     * then extracts chapter objects from the React tree.
     */
    async findChapters(seriesId) {
        if (!this.isUUID(seriesId)) {
            // Non-UUID is likely an AniList ID — search() must return Astral UUIDs
            return [];
        }

        try {
            // First attempt: RSC header
            var res = await this._fetch(this.api + '/manga/' + seriesId, {
                'RSC': '1'
            });

            if (!res.ok) return [];

            var html = await res.text();
            var parsed = this.parseRSC(html);

            if (!parsed) return [];

            // Find the manga object first to get its internal ID
            var mangaObj = this._findBySignature(parsed, 'manga');
            var mangaData = mangaObj ? mangaObj.data : parsed;

            // Find all chapter objects in the RSC tree
            var mangaInternalId = '';
            if (mangaData && mangaData.id) {
                mangaInternalId = mangaData.id;
            }

            var chapterNodes = this._findAllChapters(parsed, mangaInternalId);

            if (chapterNodes.length === 0) {
                // Retry with cache-busting parameter (mimics Tachiyomi retry logic)
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

            // Build chapter list
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
     * Strategy 1: Parse RSC data for image objects with link + orderId
     * Strategy 2: Regex for s3: keys in the HTML
     * Strategy 3: <img alt~=^Page \d+> elements
     */
    async findChapterPages(chapterId) {
        try {
            var parts = chapterId.split('|');
            if (parts.length !== 2) return [];

            var mangaId = parts[0];
            var chId = parts[1];

            var url = this.api + '/manga/' + mangaId + '/chapter/' + chId;
            var res = await this._fetch(url);

            if (!res.ok) return [];

            var html = await res.text();

            // Strategy 1: Parse RSC data for RscImageDto objects
            var parsed = this.parseRSC(html);
            if (parsed) {
                // Walk tree to find all image objects (link + orderId)
                var images = this._findAllImages(parsed);
                if (images.length > 0) {
                    // Sort by orderId
                    images.sort(function (a, b) {
                        return a.orderId - b.orderId;
                    });

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
                            headers: {
                                'Referer': url,
                            },
                        });
                    }
                    if (pages.length > 0) return pages;
                }
            }

            // Strategy 2: Regex for s3: keys in the HTML
            var s3KeyRegex = /s3:uploads\/projects\/[a-f0-9-]{36}\/chapters\/[a-f0-9-]{36}\/[^"'\s,}\]]+/g;
            var s3Keys = html.match(s3KeyRegex);
            if (s3Keys && s3Keys.length > 0) {
                // Filter out cover thumbnails
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
                        headers: {
                            'Referer': url,
                        },
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
                            headers: {
                                'Referer': url,
                            },
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

    /**
     * Walk RSC tree to find all image objects (link + orderId).
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
}
