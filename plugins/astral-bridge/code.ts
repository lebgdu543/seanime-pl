/// <reference path="../../plugin.d.ts" />
/// <reference path="../../app.d.ts" />
/// <reference path="../../system.d.ts" />
/// <reference path="../../core.d.ts" />

var API_BASE = 'https://astral-manga.fr';
var STORE_KEY = 'astral-manga-cookies';
var REFRESH_MS = 25 * 60 * 1000;

var refreshCookies = function(ctx) {
    return ctx.fetch(API_BASE + '/', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
        }
    }).then(function(res) {
        if (!res.ok) {
            console.warn('[astral-bridge] Homepage returned ' + res.status);
            return false;
        }
        var cookies = res.cookies || {};
        var cf = cookies['cf_clearance'];
        if (cf) {
            $store.set(STORE_KEY, {
                cf_clearance: cf,
                __cf_bm: cookies['__cf_bm'] || '',
                refreshedAt: Date.now()
            });
            console.log('[astral-bridge] Cookies stored (cf_clearance=' + cf.substring(0, 20) + '...)');
            return true;
        } else {
            console.warn('[astral-bridge] No cf_clearance in response cookies');
            return false;
        }
    }).catch(function(e) {
        console.error('[astral-bridge] Error:', e.message || e);
        return false;
    });
};

$ui.register(function(ctx) {
    console.log('[astral-bridge] Plugin loaded');

    var tray = ctx.newTray({
        iconUrl: '',
        withContent: false
    });

    tray.onClick(function() {
        refreshCookies(ctx).then(function(ok) {
            tray.updateBadge({ number: ok ? 0 : 1, intent: ok ? 'success' : 'error' });
        });
    });

    refreshCookies(ctx).then(function(ok) {
        tray.updateBadge({ number: ok ? 0 : 1, intent: ok ? 'success' : 'error' });
    });

    ctx.setInterval(function() {
        var cached = $store.get(STORE_KEY);
        if (!cached || Date.now() - cached.refreshedAt > REFRESH_MS) {
            console.log('[astral-bridge] Periodic refresh...');
            refreshCookies(ctx).then(function(ok) {
                tray.updateBadge({ number: ok ? 0 : 1, intent: ok ? 'success' : 'error' });
            });
        }
    }, 60 * 1000);
});
