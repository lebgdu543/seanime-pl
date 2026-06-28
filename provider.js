/// <reference path="./manga-provider.d.ts" />

/**
 * Seanime Manga Provider for Astral-Manga.fr
 *
 * Site: French manga/manhwa scanlation (Next.js App Router)
 *
 * URL structure:
 *   Manga:   /manga/{mangaUuid}
 *   Chapter: /manga/{mangaUuid}/chapter/{chapterUuid}
 *   Images:  /api/s3/presign-get?key=...
 *
 * The site embeds Next.js RSC data in self.__next_f.push([1,"..."])
 * chunks within HTML script tags. We parse those to extract manga
 * metadata and chapter data. RSC-only requests (?_rsc=..., RSC: 1)
 * return 403 so we always fetch the full HTML page.
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

    resolveImage(s3Key) {
        var raw = s3Key.replace(/^s3:/, '');
        return this.api + '/api/s3/presign-get?key=' + encodeURIComponent(raw);
    }

    /**
     * Parse React Server Components wire format from HTML.
     * Extracts all self.__next_f.push([1,"..."]) chunks, unescapes them,
     * and tries to parse a JSON tree with manga/chapter data.
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
            var lines = combined.split('\n').filter(Boolean);
            for (var i = 0; i < lines.length; i++) {
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
     * Manga: has "title" string AND "chapters" array
     * Chapter: has "id" string AND "images" array (but NOT "chapters")
     */
    _findBySignature(node, type) {
        if (!node || typeof node !== 'object') return null;

        // Manga signature
        if (!type || type === 'manga') {
            if (typeof node.title === 'string' && Array.isArray(node.chapters)) {
                return { type: 'manga', data: node };
            }
        }

        // Chapter signature
        if (!type || type === 'chapter') {
            if (typeof node.id === 'string' && Array.isArray(node.images) && !Array.isArray(node.chapters)) {
                return { type: 'chapter', data: node };
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

    /** Fetch the manga page HTML and extract RSC manga data */
    async fetchMangaData(mangaId) {
        var url = this.api + '/manga/' + mangaId;

        var res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        if (!res.ok) {
            throw new Error('HTTP ' + res.status + ' for ' + mangaId);
        }

        var html = await res.text();
        var parsed = this.parseRSC(html);

        if (!parsed) {
            throw new Error('No RSC data found in HTML for ' + mangaId);
        }

        var manga = this._findBySignature(parsed, 'manga');
        if (manga) return manga.data;

        if (parsed.title && Array.isArray(parsed.chapters)) {
            return parsed;
        }

        throw new Error('No manga data found in RSC for ' + mangaId);
    }

    /** Fetch chapter page HTML and extract S3 image keys */
    async fetchChapterData(mangaId, chapterId) {
        var url = this.api + '/manga/' + mangaId + '/chapter/' + chapterId;

        var res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        if (!res.ok) return null;

        var html = await res.text();

        // Strategy 1: Extract S3 keys with regex
        var s3KeyRegex = /s3:uploads\/projects\/[a-f0-9-]{36}\/chapters\/[a-f0-9-]{36}\/[^"'\s,}\]]+/g;
        var s3Keys = html.match(s3KeyRegex);
        if (s3Keys && s3Keys.length > 0) {
            var pageKeys = s3Keys.filter(function (k) {
                return k.indexOf('/cover') === -1 && k.indexOf('cover-') === -1;
            });
            return pageKeys.length > 0 ? pageKeys : s3Keys;
        }

        // Strategy 2: Parse RSC and find chapter object with images
        var parsed = this.parseRSC(html);
        if (parsed) {
            var chapter = this._findBySignature(parsed, 'chapter');
            if (chapter && chapter.data && chapter.data.images) {
                return chapter.data.images.map(function (img) {
                    if (typeof img === 'string') return img;
                    return img.link || img.key || img.url || img;
                });
            }
        }

        return null;
    }

    // =================================================================
    //  Provider Interface
    // =================================================================

    async search(opts) {
        var q = (opts.query || '').trim();
        if (!q) return [];

        var searchUrl = this.api + '/search?q=' + encodeURIComponent(q);

        try {
            var res = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
                },
            });

            if (!res.ok) return [];

            var html = await res.text();

            // Try RSC parsing first (search page or direct match)
            var parsed = this.parseRSC(html);
            if (parsed) {
                var manga = this._findBySignature(parsed, 'manga');
                if (manga && manga.data) {
                    var d = manga.data;
                    var img;
                    if (d.cover && d.cover.image && d.cover.image.link) {
                        img = this.resolveImage(d.cover.image.link);
                    } else if (d.image) {
                        img = this.resolveImage(d.image);
                    }
                    return [{
                        id: d.id || '',
                        title: d.title || '',
                        image: img,
                    }];
                }
                if (parsed.title && Array.isArray(parsed.chapters)) {
                    var img2;
                    if (parsed.cover && parsed.cover.image && parsed.cover.image.link) {
                        img2 = this.resolveImage(parsed.cover.image.link);
                    }
                    return [{
                        id: parsed.id || '',
                        title: parsed.title,
                        image: img2,
                    }];
                }
            }

            // Fallback: extract manga links from search results HTML
            var linkRegex = /\/manga\/([a-f0-9-]{36})[^"]*"[^>]*>([^<]+)</gi;
            var results = [];
            var seen = {};
            var match;
            while ((match = linkRegex.exec(html)) !== null) {
                var id = match[1];
                var title = match[2].trim();
                if (!seen[id] && title.length > 1) {
                    seen[id] = true;
                    results.push({ id: id, title: title });
                }
            }

            return results;
        } catch (e) {
            return [];
        }
    }

    async findChapters(seriesId) {
        try {
            var data = await this.fetchMangaData(seriesId);
            var chapters = [];

            if (data.chapters && Array.isArray(data.chapters)) {
                for (var i = 0; i < data.chapters.length; i++) {
                    var ch = data.chapters[i];
                    if (!ch.id) continue;

                    var num = ch.number || ch.chapter;
                    if (num === undefined || num === null) {
                        num = i;
                    }

                    // Composite ID: mangaUuid|chapterUuid
                    var compositeId = seriesId + '|' + ch.id;

                    chapters.push({
                        id: compositeId,
                        url: this.api + '/manga/' + seriesId + '/chapter/' + ch.id,
                        title: ch.title || ('Chapter ' + num),
                        chapter: String(num),
                        index: i,
                    });
                }
            }

            return chapters;
        } catch (e) {
            return [];
        }
    }

    async findChapterPages(chapterId) {
        try {
            // Split composite ID: mangaUuid|chapterUuid
            var parts = chapterId.split('|');
            if (parts.length !== 2) return [];

            var mangaId = parts[0];
            var chId = parts[1];

            var keys = await this.fetchChapterData(mangaId, chId);
            if (!keys || keys.length === 0) return [];

            var pages = [];
            for (var i = 0; i < keys.length; i++) {
                var url;
                if (typeof keys[i] === 'string') {
                    url = this.resolveImage(keys[i]);
                } else {
                    url = this.resolveImage(keys[i].link || keys[i].key || keys[i].url || keys[i]);
                }
                pages.push({
                    url: url,
                    index: i,
                    headers: {
                        'Referer': this.api + '/manga/' + mangaId + '/chapter/' + chId,
                    },
                });
            }

            return pages;
        } catch (e) {
            return [];
        }
    }
}
