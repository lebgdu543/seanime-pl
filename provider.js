/**
 * Seanime Extension for Astral Manga
 * Implements MangaProvider interface for 'https://astral-manga.fr'.
 * 
 * Based on the Madara WordPress theme (detected via open-source
 * Paperback/Aidoku extension analysis). Uses DOMParser for HTML
 * parsing since Seanime extensions run in a browser context.
 * 
 * Cloudflare: transparent — the plugin runs client-side, so the
 * user's browser already has CF clearance cookies.
 */
class Provider {

    constructor() {
        this.api = 'https://astral-manga.fr';
        this.sourcePath = 'manga';
    }

    api = '';
    sourcePath = '';

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        };
    }

    // ── Helpers ────────────────────────────────────────────

    /** Shared fetch headers that mimic a real browser. */
    _headers(referer) {
        return {
            'Referer': referer || `${this.api}/`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
            'Cookie': 'wpmanga-adault=1',  // include adult content in searches
        };
    }

    /** Safely parse HTML and run a callback on the document. */
    _parseHTML(html, callback) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            return callback(doc);
        } catch (e) {
            return null;
        }
    }

    /** Extract the internal WordPress manga ID from the manga page HTML.
     *  Madara stores it in <script id="wp-manga-js-extra"> as:
     *  ..."manga_id":"12345"...  (or base64-encoded in the src attr). */
    _extractMangaId(html) {
        // Try inline script first
        const match = html.match(/"manga_id"\s*:\s*"?(\d+)"?/);
        if (match) return match[1];

        // Try base64-encoded src variant
        const srcMatch = html.match(/<script[^>]+id="wp-manga-js-extra"[^>]+src="data:text\/javascript;base64,([^"]+)"/);
        if (srcMatch) {
            try {
                const decoded = atob(srcMatch[1]);
                const idMatch = decoded.match(/"manga_id"\s*:\s*"?(\d+)"?/);
                if (idMatch) return idMatch[1];
            } catch (e) { /* fall through */ }
        }

        return null;
    }

    /** Extract image URL from an <img> element, trying common lazy-load attributes. */
    _extractImage(img) {
        if (!img) return undefined;
        return img.getAttribute('data-src')
            || img.getAttribute('data-lazy-src')
            || img.getAttribute('src')
            || img.getAttribute('srcset')?.split(',')[0]?.trim()?.split(' ')[0]
            || undefined;
    }

    // ── MangaProvider methods ──────────────────────────────

    /**
     * Search for manga by title.
     * Returns array of { id, title, synonyms?, image? }.
     */
    async search(opts) {
        const query = opts.query;
        const url = `${this.api}/?post_type=wp-manga&s=${encodeURIComponent(query)}`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: this._headers(),
            });

            if (!response.ok) return [];

            const html = await response.text();

            return this._parseHTML(html, (doc) => {
                const results = [];
                const cards = doc.querySelectorAll('div.c-tabs-item__content');

                for (const card of cards) {
                    const link = card.querySelector('h3 a');
                    if (!link) continue;

                    const href = link.getAttribute('href') || '';
                    // URL: /manga/{slug}/  → extract slug
                    const slug = href.split('/').filter(Boolean).pop() || '';

                    const title = link.textContent.trim();
                    if (!title || !slug) continue;

                    const img = card.querySelector('img');
                    const image = this._extractImage(img);

                    // Latest chapter as subtitle
                    const chapterLink = card.querySelector('.latest-chap .chapter a');
                    const subtitle = chapterLink?.textContent.trim() || undefined;

                    results.push({
                        id: slug,
                        title: title,
                        synonyms: subtitle ? [subtitle] : undefined,
                        image: image,
                    });
                }

                return results;
            }) || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Fetch all chapters for a given manga (slug).
     * Returns array of { id, url, title, chapter, index }.
     */
    async findChapters(mangaId) {
        const mangaUrl = `${this.api}/${this.sourcePath}/${mangaId}/`;

        try {
            // Step 1: fetch manga page to extract internal WP ID
            const pageResponse = await fetch(mangaUrl, {
                method: 'GET',
                headers: this._headers(),
            });

            if (!pageResponse.ok) return [];

            const pageHtml = await pageResponse.text();

            // Verify this page actually has chapters (check for chapter list or manga-js-extra)
            const hasChapters = pageHtml.includes('wp-manga-chapter')
                             || pageHtml.includes('manga_id');
            if (!hasChapters) return [];

            // Step 2: extract internal manga ID
            const internalId = this._extractMangaId(pageHtml);
            if (!internalId) {
                // Fallback: try scraping chapters directly from the manga page
                return this._parseHTML(pageHtml, (doc) => {
                    return this._parseChapterList(doc, mangaId);
                }) || [];
            }

            // Step 3: AJAX fetch all chapters
            const ajaxUrl = `${this.api}/${this.sourcePath}/${mangaId}/ajax/chapters`;
            const ajaxResponse = await fetch(ajaxUrl, {
                method: 'POST',
                headers: {
                    ...this._headers(mangaUrl),
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: `action=manga_get_chapters&manga=${internalId}`,
            });

            if (!ajaxResponse.ok) return [];

            const ajaxHtml = await ajaxResponse.text();

            return this._parseHTML(ajaxHtml, (doc) => {
                return this._parseChapterList(doc, mangaId);
            }) || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Parse <li class="wp-manga-chapter"> elements from a document.
     */
    _parseChapterList(doc, mangaId) {
        const chapters = [];
        const items = doc.querySelectorAll('li.wp-manga-chapter');

        for (const item of items) {
            const link = item.querySelector('a');
            if (!link) continue;

            const href = link.getAttribute('href') || '';
            // href looks like: /manga/{slug}/{chapter-slug}/
            // Extract just the chapter slug part (after the manga slug)
            const parts = href.split('/').filter(Boolean);
            const chapterSlug = parts[parts.length - 1] || '';

            // Try to extract chapter number from the slug (e.g. "chapter-150" → 150)
            let chapNum = '0';
            const numMatch = chapterSlug.match(/chapitre-(\d+(?:[.-]\d+)?)/i)
                          || chapterSlug.match(/chapter-(\d+(?:[.-]\d+)?)/i)
                          || chapterSlug.match(/(\d+(?:[.-]\d+)?)/);
            if (numMatch) {
                chapNum = numMatch[1].replace('-', '.');
            }

            // Build title: use link text or fall back to formatted chapter number
            const rawTitle = link.textContent.trim();
            let title = rawTitle;
            if (!title || title === chapterSlug) {
                title = `Chapitre ${chapNum}`;
            }

            // chapterId encodes both slug and chapter slug for findChapterPages
            const chapterId = `${mangaId}|${chapterSlug}`;

            chapters.push({
                id: chapterId,
                url: href.startsWith('http') ? href : `${this.api}${href}`,
                title: title,
                chapter: chapNum,
                index: 0,  // will be set after sorting
            });
        }

        // Sort numerically ascending, then set indices
        chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter));
        chapters.forEach((c, i) => { c.index = i; });

        return chapters;
    }

    /**
     * Fetch all page images for a given chapter.
     * chapterId format: "slug|chapterSlug"
     * Returns array of { url, index, headers }.
     */
    async findChapterPages(chapterId) {
        const parts = chapterId.split('|');
        const mangaId = parts[0];
        const chapterSlug = parts.slice(1).join('|');  // handle slugs with | in them

        const pageUrl = `${this.api}/${this.sourcePath}/${mangaId}/${chapterSlug}/?style=list`;
        const referer = `${this.api}/${this.sourcePath}/${mangaId}/${chapterSlug}/`;

        try {
            const response = await fetch(pageUrl, {
                method: 'GET',
                headers: this._headers(referer),
            });

            if (!response.ok) return [];

            const html = await response.text();

            return this._parseHTML(html, (doc) => {
                const pages = [];
                const images = doc.querySelectorAll('div.page-break > img, div.reading-content img, div.page-break img');

                images.forEach((img, i) => {
                    const url = this._extractImage(img);
                    if (url) {
                        pages.push({
                            url: url,
                            index: i,
                            headers: { 'Referer': referer },
                        });
                    }
                });

                return pages;
            }) || [];
        } catch (e) {
            return [];
        }
    }
}
