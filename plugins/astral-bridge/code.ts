/// <reference path="../../plugin.d.ts" />
/// <reference path="../../app.d.ts" />
/// <reference path="../../system.d.ts" />
/// <reference path="../../core.d.ts" />

const API_BASE = 'https://astral-manga.fr';
const STORE_KEY = 'astral-manga-cookies';
const REFRESH_MS = 25 * 60 * 1000; // 25 min

async function refreshCookies(ctx: $ui.Context): Promise<boolean> {
    try {
        console.log('[astral-bridge] Solving Cloudflare challenge...');
        const res = await ctx.fetch(API_BASE + '/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            },
        });

        if (!res.ok) {
            console.warn('[astral-bridge] Homepage returned ' + res.status);
            return false;
        }

        const cookies = res.cookies || {};
        const cf = cookies['cf_clearance'];

        if (cf) {
            $store.set(STORE_KEY, {
                cf_clearance: cf,
                __cf_bm: cookies['__cf_bm'] || '',
                refreshedAt: Date.now(),
            });
            console.log('[astral-bridge] Cookies stored ✓ (cf_clearance=' + cf.substring(0, 20) + '...)');
            return true;
        } else {
            console.warn('[astral-bridge] No cf_clearance in response. Got keys:', Object.keys(cookies).join(', '));
            return false;
        }
    } catch (e: any) {
        console.error('[astral-bridge] Error:', e.message || e);
        return false;
    }
}

$ui.register((ctx: $ui.Context) => {
    console.log('[astral-bridge] Plugin loaded');

    const tray = ctx.newTray({
        iconUrl: '',
        withContent: false,
    });

    // Click to manually refresh
    tray.onClick(() => {
        refreshCookies(ctx).then(ok => {
            tray.updateBadge({ number: ok ? 0 : 1, intent: ok ? 'success' : 'error' });
        });
    });

    // Initial solve
    refreshCookies(ctx).then(ok => {
        tray.updateBadge({ number: ok ? 0 : 1, intent: ok ? 'success' : 'error' });
    });

    // Periodic refresh every minute (only if stale)
    ctx.setInterval(() => {
        const cached = $store.get<any>(STORE_KEY);
        if (!cached || Date.now() - cached.refreshedAt > REFRESH_MS) {
            console.log('[astral-bridge] Periodic refresh...');
            refreshCookies(ctx).then(ok => {
                tray.updateBadge({ number: ok ? 0 : 1, intent: ok ? 'success' : 'error' });
            });
        }
    }, 60 * 1000);
});
