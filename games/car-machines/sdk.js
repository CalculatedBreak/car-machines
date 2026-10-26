// POKI sdk.js (V6.4.0) -- ad-free build: rewarded breaks grant the reward instantly
(() => {
    "use strict";

    const GA_ID = 'G-ZL2MS6ZDBK';

    // Lightweight GA4 event so you can still see how often rewards are claimed.
    // Delete this function (and the one call to it below) if you don't want any tracking.
    function trackEvent(eventName, params) {
        try {
            if (!window.gtag) {
                window.dataLayer = window.dataLayer || [];
                window.gtag = function () { window.dataLayer.push(arguments); };
                window.gtag('js', new Date());
                window.gtag('config', GA_ID, { send_page_view: false });
                const s = document.createElement('script');
                s.async = true;
                s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
                document.head.appendChild(s);
            }
            window.gtag('event', eventName, Object.assign({
                game: location.pathname.split('/')[1] || '(unknown)'
            }, params || {}));
        } catch (e) {}
    }

    // Rewarded break: no ad is shown, the reward is granted immediately.
    function showRewardedAd() {
        console.log('[PokiSDK] Rewarded break: instant reward (no ad)');
        trackEvent('reward_granted', { ad_source: 'none', ad_type: 'rewarded' });
        return Promise.resolve(true);
    }

    const noop = () => {};
    const promiseTrue = () => Promise.resolve(true);
    const promiseEmpty = () => Promise.resolve([]);
    const promiseEmptyObj = () => Promise.resolve({});

    window.PokiSDK = {
        init: promiseTrue,
        initWithVideoHB: promiseTrue,
        commercialBreak: promiseTrue,
        rewardedBreak: showRewardedAd,
        displayAd: noop,
        destroyAd: noop,
        isAdBlocked: () => false,
        muteAd: noop,
        movePill: noop,
        setDebug: noop,
        setLogging: noop,
        setPlayerAge: noop,
        enableEventTracking: noop,
        playtestSetCanvas: noop,
        playtestCaptureHtmlOnce: noop,
        playtestCaptureHtmlOn: noop,
        playtestCaptureHtmlOff: noop,
        measure: noop,
        captureError: noop,
        logError: noop,
        customEvent: () => ({ doNothing: noop }),
        gameLoadingStart: noop,
        gameLoadingProgress: noop,
        gameLoadingFinished: noop,
        gameInteractive: noop,
        gameplayStart: noop,
        gameplayStop: noop,
        happyTime: noop,
        roundStart: noop,
        roundEnd: noop,
        sendHighscore: noop,
        setDebugTouchOverlayController: noop,
        setPlaytestCanvas: noop,

        getLeaderboard: promiseEmpty,
        showLeaderboard: (id) => {
            console.info('[PokiSDK] showLeaderboard:', id);
            if (window.parent !== window) {
                window.parent.postMessage({
                    type: 'pokiMessageShowLeaderboard',
                    content: { data: { id: id || -1 } }
                }, '*');
            }
        },

        getLanguage: () => navigator.language.split('-')[0] || 'en',
        getIsoLanguage: () => new URLSearchParams(window.location.search).get('iso_lang') || undefined,
        getURLParam: (p) => {
            const params = new URLSearchParams(window.location.search);
            return params.get(`gd${p}`) || params.get(p) || "";
        },

        getUser: promiseEmptyObj,
        getToken: () => Promise.resolve(null),
        login: () => Promise.reject(new Error('Login not supported')),

        openExternalLink: (url) => {
            console.info('[PokiSDK] openExternalLink:', url);
            if (window.parent !== window) {
                window.parent.postMessage({
                    type: 'pokiMessageOpenExternalLink',
                    content: { params: { url } }
                }, '*');
            } else {
                window.open(url, '_blank');
            }
        },

        shareableURL: () => Promise.resolve({ url: window.location.href }),
        generateScreenshot: () => Promise.resolve(null)
    };


    // --- Unity bridge globals -------------------------------------------------
    // Unity builds reach these through _JS_PokiSDK_* as *window* functions, not as
    // PokiSDK methods. If they are absent the bridge never registers, the C# side
    // keeps a null reference, and the first use throws NullReferenceException.
    let pokiBridgeObjectName = null;
    const pokiInitStatus = 'ready';

    function bridgeSend(method, arg) {
        try {
            if (!window.unityGame || !pokiBridgeObjectName) return;
            if (arg === undefined) window.unityGame.SendMessage(pokiBridgeObjectName, method);
            else window.unityGame.SendMessage(pokiBridgeObjectName, method, arg);
        } catch (e) { console.warn('[PokiSDK] bridge send failed:', method, e); }
    }
    function whenUnityReady(fn) {
        if (window.unityGame) return fn();
        let tries = 0;
        const t = setInterval(() => {
            if (window.unityGame || ++tries > 900) { clearInterval(t); if (window.unityGame) fn(); }
        }, 100);
    }
    function settle(p, ok, fail) {
        try { Promise.resolve(p).then(ok, fail || ok); } catch (e) { (fail || ok)(); }
    }

    window.getUser = function () {
        settle(PokiSDK.getUser(),
            (u) => bridgeSend('getUserResolved', JSON.stringify(u || {})),
            () => bridgeSend('getUserRejected'));
    };
    window.getToken = function () {
        settle(PokiSDK.getToken(),
            (t) => bridgeSend('getTokenResolved', t || ''),
            () => bridgeSend('getTokenRejected'));
    };
    window.login = function () {
        settle(PokiSDK.login(), () => bridgeSend('loginResolved'), () => bridgeSend('loginRejected'));
    };

    // Some Unity/PokiSDK plugin builds call this from their JS bridge (e.g.
    // _JS_PokiSDK_redirect, _JS_PokiSDK_destroyAd) to stringify whatever value
    // they're about to hand to a PokiSDK method -- it was never defined in this
    // stub, so any game whose build calls it threw an uncaught TypeError before
    // it could do anything else (found via Kiwi Clicker, 2026-09-08). Every
    // PokiSDK method it feeds into here is itself a no-op (see e.g. customEvent
    // above), so exact fidelity to Poki's real implementation doesn't matter --
    // this only needs to turn whatever it's given into a string without
    // throwing, so execution can continue past this call.
    window.properUnityStringify = function (v) {
        try {
            if (v == null) return '';
            return typeof v === 'string' ? v : JSON.stringify(v);
        } catch (e) { return String(v); }
    };

    console.log("%c PokiSDK V6.4.0 Ready (no ads) ", "background: #222; color: #fbff00; padding: 5px; border-radius: 3px;");
})();
