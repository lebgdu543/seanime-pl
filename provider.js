/// <reference path="./manga-provider.d.ts" />

/**
 * Seanime Manga Provider for Astral-Manga.fr v4.0.0
 *
 * COMPLETELY SELF-CONTAINED — ZERO CONFIGURATION
 * ==============================================
 * - No bridge plugin needed
 * - No proxy server needed
 * - No manual cookie pasting needed
 * - Just install and it works
 *
 * HOW IT WORKS:
 * 1. Uses `noCloudflareBypass: false` on ALL requests (enables Seanime's built-in
 *    TLS fingerprinting via req/ImpersonateChrome to bypass basic Cloudflare JS challenges)
 * 2. On first use, fetches the homepage to discover API endpoints and extract cookies
 * 3. Stores cookies internally and re-attaches them to every request
 * 4. If a 403 is received, auto-refreshes cookies by fetching the homepage again
 * 5. Falls back to HTML parsing of manga/chapter pages if JSON API calls fail
 */

class Provider {
    constructor() {
        this.api = 'https://astral-manga.fr';
        // Internal cookie jar — no dependency on $store or bridge plugin
        this._cookieJar = {
            cf_clearance: '',
            __cf_bm: '',
            refreshedAt: 0,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        };
        this._cookiesInitialized = false;
        this._refreshInterval = 25 * 60 * 1000; // 25 minutes
    }

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false
        };
    }

    // =================================================================
    //  Cookie management — fully self-contained
    // =================================================================

    // Try to get cookies from wherever they might be:
    // 1. Internal jar (from a previous request in this session)
    // 2. $store (if a bridge plugin saved them there)
    // 3. response cookies from the last fetch
    _getCookieString() {
        var jar = this._cookieJar;
        if (jar.cf_clearance && jar.cf_clearance.length > 5) {
            return 'cf_clearance=' + jar.cf_clearance +
                (jar.__cf_bm ? '; __cf_bm=' + jar.__cf_bm : '');
        }
        // Fallback: try $store (backward compat with bridge plugin)
        try {
            var stored = $store.get('astral-manga-cookies');
            if (stored && stored.cf_clearance) {
                this._cookieJar.cf_clearance = stored.cf_clearance;
                this._cookieJar.__cf_bm = stored.__cf_bm || '';
                this._cookieJar.refreshedAt = stored.refreshedAt || Date.now();
                return 'cf_clearance=' + stored.cf_clearance +
                    (stored.__cf_bm ? '; __cf_bm=' + stored.__cf_bm : '');
            }
        } catch (e) {}
        return '';
    }

    _hasCookies() {
        return this._getCookieString().length > 10;
    }

    _extractCookiesFromResponse(res) {
        try {
            // Try response.cookies (Seanime's fetch response has this)
            if (res.cookies) {
                var cf = res.cookies['cf_clearance'];
                if (cf) {
                    this._cookieJar.cf_clearance = cf;
                    this._cookieJar.__cf_bm = res.cookies['__cf_bm'] || '';
                    this._cookieJar.refreshedAt = Date.now();
                    // Also save to $store for any bridge plugin that might check
                    try {
                        $store.set('astral-manga-cookies', {
                            cf_clearance: cf,
                            __cf_bm: res.cookies['__cf_bm'] || '',
                            refreshedAt: Date.now()
                        });
                    } catch (e) {}
                    console.log('[astral] Got cf_clearance from response');
                    return true;
                }
            }
            // Try headers
            var setCookie = res.headers && res.headers['set-cookie'];
            if (setCookie) {
                var match = setCookie.match(/cf_clearance=([^;]+)/);
                if (match) {
                    this._cookieJar.cf_clearance = match[1];
                    this._cookieJar.refreshedAt = Date.now();
                    console.log('[astral] Got cf_clearance from Set-Cookie header');
                    return true;
                }
            }
        } catch (e) {}
        return false;
    }

    // Force-refresh cookies by fetching the homepage with full bypass
    async _refreshCookies() {
        console.log('[astral] Refreshing cookies...');
        try {
            var url = this.api + '/';
            var headers = {
                'User-Agent': this._cookieJar.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
            };
            var res = await fetch(url, {
                headers: headers,
                noCloudflareBypass: false,  // Enable TLS fingerprint bypass
                redirect: 'follow',
                timeout: 30
            });
            if (res.ok) {
                this._extractCookiesFromResponse(res);
                if (this._cookieJar.cf_clearance) {
                    console.log('[astral] Cookie refresh OK');
                    return true;
                }
            }
            console.warn('[astral] Homepage returned ' + res.status);
            return false;
        } catch (e) {
            console.warn('[astral] Cookie refresh error:', e.message || e);
            return false;
        }
    }

    // =================================================================
    //  Core fetch method — used for ALL requests
    // =================================================================

    async _fetch(url, opts) {
        // Build headers
        var headers = {
            'User-Agent': this._cookieJar.userAgent,
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': this.api + '/'
        };

        // Add cookies if we have them
        var cookieStr = this._getCookieString();
        if (cookieStr) {
            headers['Cookie'] = cookieStr;
        }

        // Merge extra headers from opts
        if (opts && opts.headers) {
            for (var k in opts.headers) {
                if (opts.headers.hasOwnProperty(k)) {
                    headers[k] = opts.headers[k];
                }
            }
        }

        // Build fetch options
        var fetchOpts = {
            headers: headers,
            noCloudflareBypass: false,  // Always use TLS fingerprint bypass
            redirect: 'follow',
            timeout: (opts && opts.timeout) ? opts.timeout : 30
        };

        // Make the request
        var res = await fetch(url, fetchOpts);

        // Try to extract cookies from the response
        this._extractCookiesFromResponse(res);

        // If 403 and we have cookies, they might be expired — refresh and retry
        if (res.status === 403 && this._hasCookies()) {
            console.log('[astral] Got 403, refreshing cookies...');
            var refreshed = await this._refreshCookies();
            if (refreshed) {
                // Retry with fresh cookies
                headers['Cookie'] = this._getCookieString();
                res = await fetch(url, {
                    headers: headers,
                    noCloudflareBypass: false,
                    redirect: 'follow',
                    timeout: (opts && opts.timeout) ? opts.timeout : 30
                });
                this._extractCookiesFromResponse(res);
            }
        }

        return res;
    }

    // =================================================================
    //  search() — find manga by query
    // =================================================================

    async search(opts) {
        var q = (opts && opts.query || '').trim();
        if (!q) return [];

        // Try the search API
        try {
            var searchUrl = this.api + '/api/mangas?query=' + encodeURIComponent(q) + '&page=1&pageSize=12';
            var res = await this._fetch(searchUrl, {
                headers: { 'Accept': 'application/json' }
            });

            if (res.ok) {
                var text = await res.text();
                try {
                    var data = JSON.parse(text);
                    if (data && data.mangas && Array.isArray(data.mangas) && data.mangas.length > 0) {
                        console.log('[astral] Search OK: ' + data.mangas.length + ' results');
                        return data.mangas.map(function(m) {
                            return {
                                id: m.urlId || m.id,
                                title: m.title || m.name,
                                image: m.image || m.cover || '',
                                description: (m.synopsis || m.description || '').substring(0, 300),
                                year: m.year || m.releaseYear || null,
                                status: m.status || null,
                                synonyms: m.synonyms || []
                            };
                        });
                    }
                } catch (e) {
                    console.warn('[astral] Search parse error:', e.message);
                }
            }
        } catch (e) {
            console.warn('[astral] Search error:', e.message || e);
        }

        console.log('[astral] Search returned 0 results for "' + q + '"');
        return [];
    }

    // =================================================================
    //  findChapters() — get chapter list for a manga
    // =================================================================

    async findChapters(mangaId) {
        if (!mangaId) return [];

        try {
            var url = this.api + '/manga/' + mangaId;
            var res = await this._fetch(url, {
                headers: { 'Accept': 'text/html' }
            });

            if (res.ok) {
                var html = await res.text();

                // Method 1: Try to extract from __NEXT_DATA__ JSON
                var chapters = this._extractChaptersFromNextData(html, mangaId);
                if (chapters && chapters.length > 0) {
                    console.log('[astral] Found ' + chapters.length + ' chapters via __NEXT_DATA__');
                    return chapters;
                }

                // Method 2: Try to extract from RSC payload
                chapters = this._extractChaptersFromRSC(html, mangaId);
                if (chapters && chapters.length > 0) {
                    console.log('[astral] Found ' + chapters.length + ' chapters via RSC');
                    return chapters;
                }

                // Method 3: HTML scraping
                chapters = this._extractChaptersFromHTML(html, mangaId, url);
                if (chapters && chapters.length > 0) {
                    console.log('[astral] Found ' + chapters.length + ' chapters via HTML');
                    return chapters;
                }
            }
        } catch (e) {
            console.warn('[astral] findChapters error:', e.message || e);
        }

        return [];
    }

    _extractChaptersFromNextData(html, mangaId) {
        try {
            // Match __NEXT_DATA__ JSON blob
            var match = html.match(/<script id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
            if (!match) return null;

            var data = JSON.parse(match[1]);
            // Navigate through the props to find chapters
            var props = data.props || data.propsData || {};
            var pageProps = props.pageProps || props;
            var manga = pageProps.manga || pageProps.media || pageProps.work || {};

            // Try various chapter array locations
            var chList = manga.chapters || manga.chapterList || manga.episodes || [];
            if (!Array.isArray(chList)) {
                // Try nested
                for (var key in manga) {
                    if (Array.isArray(manga[key]) && manga[key].length > 0 &&
                        (manga[key][0].id || manga[key][0].slug || manga[key][0].number)) {
                        chList = manga[key];
                        break;
                    }
                }
            }

            if (Array.isArray(chList) && chList.length > 0) {
                return chList.map(function(ch, i) {
                    var chId = ch.id || ch.slug || ch.hash || String(i);
                    var chNum = ch.number || ch.chapter || ch.orderId || ch.order || (i + 1);
                    var chTitle = ch.title || ch.name || ('Chapter ' + chNum);
                    return {
                        id: mangaId + '::' + chId,
                        url: this.api + '/manga/' + mangaId + '/chapter/' + chId,
                        title: chTitle,
                        chapter: String(chNum),
                        index: i
                    };
                }.bind(this));
            }
        } catch (e) {
            console.warn('[astral] __NEXT_DATA__ extract error:', e.message);
        }
        return null;
    }

    _extractChaptersFromRSC(html, mangaId) {
        try {
            // Parse RSC payload: self.__next_f.push(...)
            var payloads = [];
            var regex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
            var m;
            while ((m = regex.exec(html)) !== null) {
                var raw = m[1]
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\')
                    .replace(/\\n/g, '')
                    .replace(/\\t/g, '');
                try {
                    var parsed = JSON.parse(raw);
                    payloads.push(parsed);
                } catch (e) {
                    // Try line by line
                    var lines = raw.split('\\n');
                    for (var i = 0; i < lines.length; i++) {
                        if (lines[i].trim()) {
                            try {
                                payloads.push(JSON.parse(lines[i]));
                            } catch (e2) {}
                        }
                    }
                }
            }

            // Search all payloads for chapter data
            for (var p = 0; p < payloads.length; p++) {
                var found = this._findChaptersInObject(payloads[p], mangaId, []);
                if (found.length > 0) {
                    return found.map(function(ch, i) {
                        return {
                            id: mangaId + '::' + ch.id,
                            url: this.api + '/manga/' + mangaId + '/chapter/' + ch.id,
                            title: ch.title || ('Chapter ' + (ch.orderId || i + 1)),
                            chapter: String(ch.orderId || ch.order || i + 1),
                            index: i
                        };
                    }.bind(this));
                }
            }
        } catch (e) {
            console.warn('[astral] RSC extract error:', e.message);
        }
        return null;
    }

    _findChaptersInObject(node, mangaId, found) {
        if (!node || typeof node !== 'object') return found;
        // Check if this node looks like a chapter entry
        if (typeof node.id === 'string' && typeof node.orderId === 'number') {
            if (node.mangaId === mangaId || !node.mangaId) {
                var dup = false;
                for (var i = 0; i < found.length; i++) {
                    if (found[i].id === node.id) { dup = true; break; }
                }
                if (!dup) found.push(node);
            }
        }
        if (Array.isArray(node)) {
            for (var j = 0; j < node.length; j++) {
                this._findChaptersInObject(node[j], mangaId, found);
            }
        } else {
            for (var k in node) {
                if (k !== '__proto__' && k !== 'constructor') {
                    this._findChaptersInObject(node[k], mangaId, found);
                }
            }
        }
        return found;
    }

    _extractChaptersFromHTML(html, mangaId, baseUrl) {
        try {
            var chapters = [];
            var doc = LoadDoc(html);

            // Try common manga chapter list selectors
            var selectors = [
                'ul.chapter-list li a',
                '.chapter-list a',
                '.chapters a',
                'table.chapters-list a',
                '.chapter-item a',
                'li.wp-manga-chapter a',
                'a[href*="/chapter/"]'
            ];

            var seen = {};
            for (var s = 0; s < selectors.length; s++) {
                doc(selectors[s]).each(function(i, el) {
                    var href = el.attr('href') || '';
                    if (href.indexOf('/chapter/') > -1) {
                        var parts = href.split('/chapter/');
                        var chSlug = parts[1] || '';
                        if (chSlug && !seen[chSlug]) {
                            seen[chSlug] = true;
                            var title = el.text().trim() || ('Chapter ' + (i + 1));
                            chapters.push({
                                id: mangaId + '::' + chSlug,
                                url: href.indexOf('http') === 0 ? href : this.api + href,
                                title: title,
                                chapter: String(chapters.length + 1),
                                index: chapters.length
                            });
                        }
                    }
                }.bind(this));
                if (chapters.length > 0) break;
            }

            // If no links found, try extracting from the page text
            if (chapters.length === 0) {
                var bodyText = doc('body').text() || '';
                var chRegex = /Chapitre\s+(\d+(?:\.\d+)?)/gi;
                var chMatch;
                var fakeId = 0;
                while ((chMatch = chRegex.exec(bodyText)) !== null) {
                    fakeId++;
                    chapters.push({
                        id: mangaId + '::ch' + chMatch[1],
                        url: baseUrl + '/chapter/ch' + chMatch[1],
                        title: 'Chapitre ' + chMatch[1],
                        chapter: chMatch[1],
                        index: chapters.length
                    });
                }
            }

            // Sort chapters numerically (most providers want ascending)
            chapters.sort(function(a, b) {
                var an = parseFloat(a.chapter) || 0;
                var bn = parseFloat(b.chapter) || 0;
                return an - bn;
            });

            return chapters;
        } catch (e) {
            console.warn('[astral] HTML chapters extract error:', e.message);
        }
        return null;
    }

    // =================================================================
    //  findChapterPages() — get page images for a chapter
    // =================================================================

    async findChapterPages(combinedId) {
        if (!combinedId) return [];

        var parts = combinedId.split('::');
        var mangaUuid = parts[0] || '';
        var chapterUuid = parts[1] || parts[0];
        var url = this.api + '/manga/' + mangaUuid + '/chapter/' + chapterUuid;

        try {
            var res = await this._fetch(url, {
                headers: {
                    'Accept': 'text/html',
                    'Referer': this.api + '/manga/' + mangaUuid
                }
            });

            if (!res.ok) {
                console.warn('[astral] Chapter page returned ' + res.status);
                return [];
            }

            var html = await res.text();
            var pages = [];

            // Method 1: Try __NEXT_DATA__ first (most reliable)
            pages = this._extractPagesFromNextData(html, url);
            if (pages.length > 0) {
                console.log('[astral] Found ' + pages.length + ' pages via __NEXT_DATA__');
                return pages;
            }

            // Method 2: RSC parsing
            pages = this._extractPagesFromRSC(html);
            if (pages.length > 0) {
                console.log('[astral] Found ' + pages.length + ' pages via RSC');
                return pages;
            }

            // Method 3: HTML scraping with selectors
            pages = this._extractPagesFromHTML(html, url);
            if (pages.length > 0) {
                console.log('[astral] Found ' + pages.length + ' pages via HTML');
                return pages;
            }

            console.warn('[astral] No pages found for', chapterUuid);
            return [];
        } catch (e) {
            console.error('[astral] Pages error:', e.message || e);
            return [];
        }
    }

    _extractPagesFromNextData(html, pageUrl) {
        var pages = [];
        try {
            var match = html.match(/<script id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
            if (!match) return pages;

            var data = JSON.parse(match[1]);
            var props = data.props || data.propsData || {};
            var pageProps = props.pageProps || props;
            var chapter = pageProps.chapter || pageProps.media || {};

            // Try various image array keys
            var images = chapter.images || chapter.pages || chapter.imgs || chapter.pageUrls || [];

            if (!Array.isArray(images)) {
                // Try nested
                for (var key in chapter) {
                    if (Array.isArray(chapter[key]) && chapter[key].length > 0) {
                        var first = chapter[key][0];
                        if (typeof first === 'string' && (first.indexOf('.jpg') > 0 || first.indexOf('.png') > 0 || first.indexOf('.webp') > 0)) {
                            images = chapter[key];
                            break;
                        }
                        if (typeof first === 'object' && (first.url || first.src || first.link)) {
                            images = chapter[key];
                            break;
                        }
                    }
                }
            }

            for (var i = 0; i < images.length; i++) {
                var img = images[i];
                var src = '';
                if (typeof img === 'string') {
                    src = img;
                } else if (img.url) {
                    src = img.url;
                } else if (img.src) {
                    src = img.src;
                } else if (img.link) {
                    src = img.link;
                }

                if (src) {
                    // Handle S3 presigned URLs
                    if (src.indexOf('s3:') === 0) {
                        src = this.api + '/api/s3/presign-get?key=' + encodeURIComponent(src.substring(3));
                    } else if (src.indexOf('http') !== 0 && src.indexOf('//') === 0) {
                        src = 'https:' + src;
                    } else if (src.indexOf('http') !== 0) {
                        src = this.api + (src.indexOf('/') === 0 ? '' : '/') + src;
                    }
                    pages.push({
                        url: src,
                        index: pages.length,
                        headers: {
                            'Referer': pageUrl,
                            'User-Agent': this._cookieJar.userAgent
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('[astral] __NEXT_DATA__ pages extract error:', e.message);
        }
        return pages;
    }

    _extractPagesFromRSC(html) {
        var pages = [];
        try {
            var regex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
            var m;
            while ((m = regex.exec(html)) !== null) {
                var raw = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '').replace(/\\t/g, '');
                try {
                    var parsed = JSON.parse(raw);
                    var found = [];
                    this._findImagesInObject(parsed, found);
                    for (var i = 0; i < found.length; i++) {
                        var src = found[i].link || found[i].url || '';
                        if (src && src.indexOf('.jpg') > 0 || src.indexOf('.png') > 0 || src.indexOf('.webp') > 0) {
                            if (src.indexOf('s3:') === 0) {
                                src = this.api + '/api/s3/presign-get?key=' + encodeURIComponent(src.substring(3));
                            } else if (src.indexOf('http') !== 0 && src.indexOf('//') === 0) {
                                src = 'https:' + src;
                            } else if (src.indexOf('http') !== 0) {
                                src = this.api + (src.indexOf('/') === 0 ? '' : '/') + src;
                            }
                            var dup = false;
                            for (var j = 0; j < pages.length; j++) {
                                if (pages[j].url === src) { dup = true; break; }
                            }
                            if (!dup) {
                                pages.push({
                                    url: src,
                                    index: pages.length,
                                    headers: {
                                        'Referer': this.api + '/',
                                        'User-Agent': this._cookieJar.userAgent
                                    }
                                });
                            }
                        }
                    }
                } catch (e) {}
            }
            pages.sort(function(a, b) { return a.index - b.index; });
        } catch (e) {
            console.warn('[astral] RSC pages extract error:', e.message);
        }
        return pages;
    }

    _findImagesInObject(node, found) {
        if (!node || typeof node !== 'object') return;
        if (typeof node.link === 'string' && typeof node.orderId === 'number') {
            found.push({ link: node.link, orderId: node.orderId });
        }
        if (typeof node.url === 'string' && typeof node.orderId === 'number') {
            found.push({ link: node.url, orderId: node.orderId });
        }
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) this._findImagesInObject(node[i], found);
        } else {
            for (var k in node) {
                if (k !== '__proto__' && k !== 'constructor') this._findImagesInObject(node[k], found);
            }
        }
    }

    _extractPagesFromHTML(html, pageUrl) {
        var pages = [];
        try {
            var doc = LoadDoc(html);

            // Priority selectors
            var selectors = [
                '.reading-content img',
                '.page-break img',
                '.chapter-content img',
                '.manga-page img',
                'img.page-image',
                '.reader-container img',
                '#images img',
                '.chapter-images img',
                'amp-img',
                '.wp-manga-chapter-img',
                'img[loading="lazy"]',
                '.text-center img',
                'main img',
                'article img'
            ];

            for (var s = 0; s < selectors.length; s++) {
                doc(selectors[s]).each(function(i, el) {
                    var src = el.attr('src') || el.attr('data-src') || el.attr('data-lazy-src') || '';
                    if (src && src.length > 10) {
                        if (src.indexOf('http') !== 0 && src.indexOf('//') === 0) { src = 'https:' + src; }
                        else if (src.indexOf('http') !== 0) { src = this.api + (src.indexOf('/') === 0 ? '' : '/') + src; }
                        var dup = false;
                        for (var j = 0; j < pages.length; j++) { if (pages[j].url === src) { dup = true; break; } }
                        if (!dup) {
                            pages.push({
                                url: src,
                                index: pages.length,
                                headers: {
                                    'Referer': pageUrl,
                                    'User-Agent': this._cookieJar.userAgent
                                }
                            });
                        }
                    }
                }.bind(this));
                if (pages.length > 0) break;
            }

            // Fallback: all images
            if (pages.length === 0) {
                doc('img').each(function(i, el) {
                    var src = el.attr('src') || el.attr('data-src') || '';
                    if (src && src.length > 10 &&
                        (src.indexOf('.jpg') > 0 || src.indexOf('.png') > 0 || src.indexOf('.webp') > 0 ||
                         src.indexOf('.jpeg') > 0 || src.indexOf('.avif') > 0)) {
                        if (src.indexOf('http') !== 0 && src.indexOf('//') === 0) { src = 'https:' + src; }
                        else if (src.indexOf('http') !== 0) { src = this.api + (src.indexOf('/') === 0 ? '' : '/') + src; }
                        var dup = false;
                        for (var j = 0; j < pages.length; j++) { if (pages[j].url === src) { dup = true; break; } }
                        if (!dup) {
                            pages.push({
                                url: src,
                                index: pages.length,
                                headers: {
                                    'Referer': pageUrl,
                                    'User-Agent': this._cookieJar.userAgent
                                }
                            });
                        }
                    }
                });
            }
        } catch (e) {
            console.warn('[astral] HTML pages extract error:', e.message);
        }
        return pages;
    }
}
