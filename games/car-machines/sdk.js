// POKI sdk.js (V6.3.0)
(() => {
    "use strict";

    const CONFIG = {
        adUnits: {
            rewarded: '/11,11/Ad.Plus-Rewarded'
        },
        fallbackVideosUrl: '/scripts/videos/videos.json',
        loadingGifUrl: '/scripts/videos/thumb_anim.gif',
        adTimeout: 4000, // was 1200ms -- too short for a real GPT auction to ever answer (owner-flagged root cause of 0% real fills), raised 2026-09-13
        minLoadingTime: 100,
        applixir: {
            // 'direct' = load AppLixir right here (use while on the sandbox key)
            // 'bridge' = post to the approved pizzaedition.com parent (use once approved)
            mode: 'direct',
            sdkUrl: 'https://cdn.applixir.com/applixir.app.v6.1.0.js',
            // SANDBOX key: test ads only, no revenue. Swap for your real key after activation.
            apiKey: '5a4db0c5-0000-4000-8000-5a4db0c50001',
            startTimeoutMs: 8000,    // ad must load/start by then, or fall through to GPT
            resultTimeoutMs: 90000   // overall cap once started
        },
        applixirBridge: {
            // games.pizzaedition.com is NOT (yet) a separately AppLixir-approved
            // domain -- only pizzaedition.com is. AppLixir reads the domain it
            // reports off its OWN frame's window.location, so it has to run in
            // the parent /embed/<slug>/ page (which IS on pizzaedition.com), not
            // here. This game-side file is only a postMessage bridge to that
            // parent -- the other half is
            // pizzaedition.com/html/jsload/applixir-parent-bridge.js.
            //
            // parentOrigins is BOTH the postMessage target and the allowlist for
            // replies. www.pizzaedition.com 301s to the apex so in practice only
            // the first entry is ever used; it is listed so a reply from either
            // is accepted and neither is ever answered with '*'.
            parentOrigins: ['https://pizzaedition.com', 'https://www.pizzaedition.com'],
            ackTimeoutMs: 2500,     // parent must ack fast if its listener exists
            resultTimeoutMs: 90000  // once acked, give a real ad plenty of room to play out
        }
    };

    // AppLixir is a rewarded-video network purpose-built for HTML5 games (approved
    // 2026-09-13) and is now the PRIMARY rewarded-ad strategy -- see showRewardedAd().
    // GPT/AdSense (which at the old 1200ms adTimeout effectively never took a
    // real fill -- see proposals/backlog.md; now 4000ms, see CONFIG.adTimeout)
    // and the house fallback video are kept as-is, demoted to secondary/tertiary
    // fallbacks so an AppLixir outage (or a parent frame too old to have the
    // bridge listener) never regresses to "no ad".

    const GA_ID = 'G-ZL2MS6ZDBK';

    function trackAdEvent(eventName, params) {
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

    let isAdActive = false;
    let fallbackVideos = [];
    let lastIndex = -1;
    let freezeTimer = null;
    let currentVideoElement = null;
    let gptSlot = null;
    let loadingOverlay = null;
    let loadingStartTime = 0;

    function injectStyles() {
        if (document.getElementById('sdk-v6-styles')) return;
        const css = `
            #poki-gameplay-freeze { position: fixed; inset: 0; z-index: 999999998; pointer-events: all; background: rgba(0,0,0,0.01); }
            .sdk-video-overlay { position: fixed; inset: 0; background: #000; z-index: 999999999; display: flex; align-items: center; justify-content: center; }
            .sdk-loading-overlay {
                position: fixed; inset: 0; background: #000; z-index: 999999999;
                display: flex; align-items: center; justify-content: center;
            }
            .sdk-loading-spinner { width: 120px; height: 120px; }
            .sdk-applixir-container { position: fixed; inset: 0; z-index: 1000000004; background: #000; }
            .sdk-cta-button {
                position: absolute; top: 36px; right: 16px;
                padding: 16px; background: #FFFFFF; color: #597ed5;
                font-family: sans-serif; font-size: 18px; font-weight: bold;
                border: 1px solid #b2b2b2; border-radius: 6px;
                text-decoration: none; z-index: 1000000002;
                transition: transform 0.2s;
                cursor: pointer;
            }
            .sdk-cta-button:hover { transform: scale(1.04); }
            .sdk-pause-container {
                display: none;
                position: absolute;
                inset: 0;
                background: rgba(0,0,0,0.3);
                z-index: 1000000001;
                cursor: pointer;
            }
            .sdk-play-icon {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 90px;
                height: 90px;
                background: rgba(0,0,0,0.3);
                border: 2px solid #fff;
                border-radius: 50px;
            }
            .sdk-play-icon::after {
                content: '';
                position: absolute;
                top: 50%;
                left: 55%;
                transform: translate(-50%, -50%);
                border-style: solid;
                border-width: 15px 0 15px 25px;
                border-color: transparent transparent transparent #fff;
            }
            .sdk-pulse { animation: sdk-pulse-anim 1.5s infinite; }
            @keyframes sdk-pulse-anim {
                0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
                100% { transform: translate(-50%, -50%) scale(1.3); opacity: 0; }
            }
            .sdk-progress-bar {
                position: fixed;
                bottom: 0;
                left: 0;
                width: 100%;
                height: 6px;
                background: rgba(255,255,255,0.3);
                z-index: 1000000003;
            }
            .sdk-progress-inner {
                width: 0%;
                height: 100%;
                background: #FFDC00;
            }
        `;
        const style = document.createElement('style');
        style.id = 'sdk-v6-styles';
        style.textContent = css;
        document.head.appendChild(style);
    }

    function initGPT() {
        window.googletag = window.googletag || { cmd: [] };

        if (!document.querySelector('script[src*="gpt.js"]')) {
            const script = document.createElement('script');
            script.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
            script.async = true;
            script.crossOrigin = 'anonymous';
            document.head.appendChild(script);
        }

        window.googletag.cmd.push(() => {
            window.googletag.pubads().enableSingleRequest();
            window.googletag.enableServices();
            console.log('[PokiSDK] GPT Core Initialized');
        });
    }

    function showLoadingIndicator() {
        if (loadingOverlay) return;
        loadingStartTime = Date.now();
        loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'sdk-loading-overlay';
        const spinner = document.createElement('img');
        spinner.src = CONFIG.loadingGifUrl;
        spinner.className = 'sdk-loading-spinner';
        loadingOverlay.appendChild(spinner);
        document.body.appendChild(loadingOverlay);
    }

    async function hideLoadingIndicator() {
        if (!loadingOverlay) return;
        const elapsed = Date.now() - loadingStartTime;
        const remainingTime = Math.max(0, CONFIG.minLoadingTime - elapsed);
        if (remainingTime > 0) await new Promise(r => setTimeout(r, remainingTime));
        if (loadingOverlay && loadingOverlay.parentNode) loadingOverlay.remove();
        loadingOverlay = null;
    }

    async function loadFallbackList() {
        try {
            const res = await fetch(CONFIG.fallbackVideosUrl, { cache: "no-store" });
            fallbackVideos = await res.json();
            console.log("[PokiSDK] Fallback list loaded");
        } catch (e) {
            console.warn("[PokiSDK] Fallback load failed");
        }
    }

    function playFallbackVideo() {
        return new Promise((resolve) => {
            if (!fallbackVideos || !fallbackVideos.length) {
                unfreezeGame();
                return resolve();
            }

            if (freezeTimer) {
                clearTimeout(freezeTimer);
                freezeTimer = null;
            }

            let index;
            do {
                index = Math.floor(Math.random() * fallbackVideos.length);
            } while (index === lastIndex && fallbackVideos.length > 1);
            lastIndex = index;
            const videoData = fallbackVideos[index];

            const overlay = document.createElement("div");
            overlay.className = "sdk-video-overlay";

            const video = document.createElement("video");
            video.src = videoData.src;
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true; // autoplay is blocked for unmuted video
            video.style.cssText = "width:100%; height:100%; object-fit:contain; cursor:pointer;";
            currentVideoElement = video;

            const pauseLayer = document.createElement("div");
            pauseLayer.className = "sdk-pause-container";
            pauseLayer.innerHTML = `
                <div class="sdk-play-icon"></div>
                <div class="sdk-play-icon sdk-pulse"></div>
            `;

            const cta = document.createElement("a");
            cta.className = "sdk-cta-button";
            cta.innerText = "Play Now!";
            cta.href = videoData.link;
            cta.target = "_blank";
            cta.onclick = (e) => {
                e.stopPropagation();
                if (!video.paused) {
                    video.pause();
                    pauseLayer.style.display = "block";
                }
            };

            const pb = document.createElement("div");
            pb.className = "sdk-progress-bar";
            const pbi = document.createElement("div");
            pbi.className = "sdk-progress-inner";
            pb.appendChild(pbi);

            overlay.appendChild(video);
            overlay.appendChild(pauseLayer);
            overlay.appendChild(cta);
            document.body.appendChild(overlay);
            document.body.appendChild(pb);

            video.onclick = (e) => {
                e.stopPropagation();
                video.pause();
                pauseLayer.style.display = "block";
            };

            pauseLayer.onclick = (e) => {
                e.stopPropagation();
                video.play();
                pauseLayer.style.display = "none";
            };

            const updateProgressBar = () => {
                if (video.duration) {
                    pbi.style.width = (video.currentTime / video.duration) * 100 + "%";
                }
                if (!video.paused && !video.ended) {
                    requestAnimationFrame(updateProgressBar);
                }
            };

            video.addEventListener('play', () => {
                requestAnimationFrame(updateProgressBar);
            });

            requestAnimationFrame(updateProgressBar);

            let adSettled = false;
            let adGuard = null;
            const onVideoEnd = () => {
                if (adSettled) return;
                adSettled = true;
                if (adGuard) { clearTimeout(adGuard); adGuard = null; }
                unfreezeGame();
                resolve();
            };
            video.onended = () => {
                trackAdEvent('ad_watched', { ad_source: 'fallback_video' });
                onVideoEnd();
            };
            video.onerror = onVideoEnd;
            // tap the ad to hear it; muted only so autoplay is permitted
            overlay.addEventListener('click', () => { try { video.muted = false; } catch (e) {} });
            try {
                const pp = video.play();
                if (pp && typeof pp.catch === 'function') pp.catch(() => onVideoEnd());
            } catch (e) { onVideoEnd(); }
            // last-resort settle: never let the overlay outlive the ad
            adGuard = setTimeout(onVideoEnd, 45000);
        });
    }

    // --- AppLixir (primary rewarded-ad strategy, 2026-09-13) -------------------
    // Two modes, picked by CONFIG.applixir.mode:
    //   'bridge' -- this game runs on games.pizzaedition.com, which is NOT itself
    //               an AppLixir-approved domain (only pizzaedition.com is, and
    //               getting a second domain approved is a manual 1-2 business day
    //               review). So this posts a request up to the parent /embed/<slug>/
    //               page -- same-origin as pizzaedition.com, already approved --
    //               which does the actual AppLixir call and posts the outcome back.
    //               Same cross-frame shape the stub already uses for
    //               pokiMessageShowLeaderboard / pokiMessageOpenExternalLink below.
    //   'direct' -- loads the AppLixir SDK in this frame and calls
    //               initializeAndOpenPlayer() here. Used while on the sandbox key.
    let applixirBridgeListenerInstalled = false;
    let applixirRequestSeq = 0;
    const applixirPendingRequests = new Map();

    // The parent frame is always the /embed/<slug>/ wrapper, so document.referrer
    // is that page. It is used ONLY to choose between the two known-good entries
    // in parentOrigins, never to widen them: an unknown referrer falls back to
    // the apex rather than being trusted.
    function applixirParentOrigin() {
        try {
            const ref = document.referrer;
            if (ref) {
                const origin = new URL(ref).origin;
                if (CONFIG.applixirBridge.parentOrigins.indexOf(origin) !== -1) return origin;
            }
        } catch (e) {}
        return CONFIG.applixirBridge.parentOrigins[0];
    }

    function installApplixirBridgeListener() {
        if (applixirBridgeListenerInstalled) return;
        applixirBridgeListenerInstalled = true;
        window.addEventListener('message', (event) => {
            // A forged "success" here is a free reward with no ad ever shown, so
            // the sender is verified before anything else: it must be the exact
            // parent frame AND an approved pizzaedition.com origin. Any other
            // frame that can reach this window (an ad iframe, an injected frame,
            // another tab's opener) is ignored outright.
            if (event.source !== window.parent) return;
            if (CONFIG.applixirBridge.parentOrigins.indexOf(event.origin) === -1) return;
            const data = event.data;
            if (!data || typeof data !== 'object') return;
            if (typeof data.requestId !== 'string') return;
            const req = applixirPendingRequests.get(data.requestId);
            if (!req) return;
            if (data.type === 'pokiMessageRewardedAdAck') {
                req.onAck();
            } else if (data.type === 'pokiMessageRewardedAdResult') {
                if (data.success === true) req.resolve();
                else req.reject(new Error('applixir_bridge_' + (typeof data.reason === 'string' ? data.reason.slice(0, 40) : 'failed')));
            }
        });
    }

    function showApplixirRewardedAd() {
        return new Promise((resolve, reject) => {
            if (window.parent === window) {
                // not embedded inside the pizzaedition.com /embed/ wrapper -- no
                // bridge target exists (e.g. a direct/dev load of the game itself)
                return reject(new Error('applixir_no_parent_frame'));
            }
            installApplixirBridgeListener();

            const requestId = 'ax_' + Date.now() + '_' + (++applixirRequestSeq);
            let settled = false;
            let ackTimer = null;
            let resultTimer = null;

            const finish = (ok, err) => {
                if (settled) return;
                settled = true;
                clearTimeout(ackTimer);
                clearTimeout(resultTimer);
                applixirPendingRequests.delete(requestId);
                if (ok) {
                    console.log('[PokiSDK] AppLixir (bridge): complete');
                    trackAdEvent('ad_watched', { ad_source: 'applixir', ad_type: 'rewarded' });
                    resolve();
                } else {
                    const reason = (err && err.message) || 'applixir_bridge_failed';
                    console.warn('[PokiSDK] AppLixir (bridge) failed:', reason);
                    // Counterpart to the ad_watched above: without this the only
                    // measurable AppLixir outcome is success, and a 0% fill rate
                    // would look identical to nobody ever asking for an ad.
                    trackAdEvent('ad_failed', { ad_source: 'applixir', ad_type: 'rewarded', reason: String(reason).slice(0, 60) });
                    reject(err || new Error('applixir_bridge_failed'));
                }
            };

            applixirPendingRequests.set(requestId, {
                resolve: () => finish(true),
                reject: (e) => finish(false, e),
                onAck: () => {
                    // parent has the listener and is loading/showing the real ad now --
                    // stop racing the short ack window, wait out the real ad instead.
                    if (settled || resultTimer) return; // a duplicate ack must not leak a timer
                    clearTimeout(ackTimer);
                    resultTimer = setTimeout(
                        () => finish(false, new Error('applixir_bridge_result_timeout')),
                        CONFIG.applixirBridge.resultTimeoutMs
                    );
                }
            });

            // If the parent page is an old cached copy without this listener yet
            // (see the experiment.js ?v= cache-busting notes for why that happens
            // on this site), no ack ever arrives -- fail fast into the GPT/house
            // fallback chain instead of hanging the visitor.
            ackTimer = setTimeout(
                () => finish(false, new Error('applixir_bridge_no_ack')),
                CONFIG.applixirBridge.ackTimeoutMs
            );

            try {
                window.parent.postMessage(
                    { type: 'pokiMessageShowRewardedAd', requestId },
                    applixirParentOrigin()
                );
            } catch (e) {
                finish(false, e);
            }
        });
    }

    // --- AppLixir direct (loads the SDK in this frame) ---------------------------
    let applixirSdkPromise = null;

    function loadApplixirSdk() {
        if (typeof window.initializeAndOpenPlayer === 'function') return Promise.resolve();
        if (applixirSdkPromise) return applixirSdkPromise;
        applixirSdkPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = CONFIG.applixir.sdkUrl;
            s.async = true;
            s.onload = () => (typeof window.initializeAndOpenPlayer === 'function'
                ? resolve()
                : reject(new Error('applixir_sdk_missing')));
            s.onerror = () => { applixirSdkPromise = null; reject(new Error('applixir_sdk_blocked')); };
            document.head.appendChild(s);
        });
        return applixirSdkPromise;
    }

    function showApplixirDirectRewardedAd() {
        return new Promise((resolve, reject) => {
            let settled = false;
            let completed = false;
            let startTimer = null;
            let resultTimer = null;
            let container = null;

            const finish = (ok, err) => {
                if (settled) return;
                settled = true;
                clearTimeout(startTimer);
                clearTimeout(resultTimer);
                if (container && container.parentNode) container.remove();
                container = null;
                if (ok) {
                    console.log('[PokiSDK] AppLixir (direct): complete');
                    trackAdEvent('ad_watched', { ad_source: 'applixir', ad_type: 'rewarded' });
                    resolve();
                } else {
                    const reason = (err && err.message) || 'applixir_failed';
                    console.warn('[PokiSDK] AppLixir (direct) failed:', reason);
                    trackAdEvent('ad_failed', { ad_source: 'applixir', ad_type: 'rewarded', reason: String(reason).slice(0, 60) });
                    reject(err || new Error('applixir_failed'));
                }
            };

            loadApplixirSdk().then(() => {
                if (settled) return;

                container = document.createElement('div');
                container.id = 'applixir-ad-container';
                container.className = 'sdk-applixir-container';
                document.body.appendChild(container);

                startTimer = setTimeout(
                    () => finish(false, new Error('applixir_start_timeout')),
                    CONFIG.applixir.startTimeoutMs
                );

                const options = {
                    apiKey: CONFIG.applixir.apiKey,
                    injectionElementId: 'applixir-ad-container',
                    adStatusCallbackFn: (status) => {
                        const type = status && status.type;
                        if (type === 'loaded' || type === 'started') {
                            // ad is really playing: stop the short start race, allow a long result window
                            clearTimeout(startTimer);
                            if (!resultTimer) {
                                resultTimer = setTimeout(
                                    () => finish(false, new Error('applixir_result_timeout')),
                                    CONFIG.applixir.resultTimeoutMs
                                );
                            }
                            hideLoadingIndicator();
                        } else if (type === 'complete') {
                            completed = true;       // reward only on a genuine complete
                        } else if (type === 'allAdsCompleted') {
                            completed ? finish(true) : finish(false, new Error('applixir_no_complete'));
                        } else if (type === 'skipped' || type === 'manuallyEnded') {
                            // same "applixir_<reason>" shape isUserSkip() looks for
                            finish(false, new Error('applixir_' + type));
                        } else if (type === 'consentDeclined') {
                            finish(false, new Error('applixir_consentDeclined'));
                        }
                    },
                    adErrorCallbackFn: (error) => {
                        let msg = 'error';
                        try { msg = String(error.getError().data.errorCode || 'error'); } catch (e) {}
                        finish(false, new Error('applixir_' + msg));
                    }
                };

                try {
                    const p = window.initializeAndOpenPlayer(options);
                    if (p && typeof p.catch === 'function') p.catch((e) => finish(false, e));
                } catch (e) { finish(false, e); }
            }).catch((e) => finish(false, e));
        });
    }

    function showGPTRewardedAd() {
        return new Promise((resolve, reject) => {
            let adStarted = false;
            let settled = false;
            let timeoutId = null;
            let listeners = [];

            const cleanup = () => {
                clearTimeout(timeoutId);
                timeoutId = null;
                try {
                    listeners.forEach(l => window.googletag.pubads().removeEventListener(l.name, l.fn));
                } catch (e) {}
                listeners = [];
                try {
                    if (gptSlot) {
                        window.googletag.destroySlots([gptSlot]);
                        gptSlot = null;
                    }
                } catch (e) { gptSlot = null; }
            };
            const fail = (msg) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(msg));
            };
            const done = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };

            // ARMED BEFORE cmd.push, deliberately. googletag.cmd is a plain array
            // until gpt.js actually loads and replaces it, so if gpt.js never
            // arrives -- a school content filter or ad blocker eating
            // securepubads.g.doubleclick.net, which is the common case on this
            // site's core audience -- the callback below NEVER RUNS. With the
            // timer armed inside it (as it was until 2026-09-13) nothing ever
            // settled this promise, the await in showRewardedAd() hung forever,
            // and the visitor was left on a frozen game with a spinner and no
            // house video. Same story if anything inside the callback throws:
            // GPT's own cmd runner swallows it. This timer is the only thing
            // guaranteeing the chain can always reach playFallbackVideo().
            timeoutId = setTimeout(() => {
                if (adStarted) return; // a real ad is on screen; let it play out
                console.warn('[PokiSDK] GPT: Timeout');
                fail('timeout');
            }, CONFIG.adTimeout);

            const run = () => {
                try {
                    gptSlot = window.googletag.defineOutOfPageSlot(
                        CONFIG.adUnits.rewarded,
                        window.googletag.enums.OutOfPageFormat.REWARDED
                    );

                    if (!gptSlot) return fail('no_slot');
                    gptSlot.addService(window.googletag.pubads());

                    const addL = (name, fn) => {
                        window.googletag.pubads().addEventListener(name, fn);
                        listeners.push({ name, fn });
                    };

                    addL('slotRenderEnded', (event) => {
                        if (event.slot === gptSlot && event.isEmpty) {
                            console.log('[PokiSDK] GPT: No fill');
                            fail('no_fill');
                        }
                    });

                    addL('rewardedSlotReady', (event) => {
                        if (event.slot === gptSlot) {
                            console.log('[PokiSDK] GPT: Ad ready');
                            adStarted = true;
                            clearTimeout(timeoutId);
                            timeoutId = null;
                            hideLoadingIndicator().then(() => {
                                try { event.makeRewardedVisible(); } catch (e) { fail('make_visible_failed'); }
                            });
                        }
                    });

                    addL('rewardedSlotClosed', (event) => {
                        if (event.slot === gptSlot) {
                            console.log('[PokiSDK] GPT: Ad closed');
                            done();
                        }
                    });

                    addL('rewardedSlotGranted', (event) => {
                        if (event.slot === gptSlot) {
                            console.log('[PokiSDK] GPT: Reward granted 🎁');
                            trackAdEvent('ad_watched', { ad_source: 'gpt' });
                        }
                    });

                    window.googletag.display(gptSlot);
                } catch (e) {
                    console.warn('[PokiSDK] GPT: threw', e && e.message);
                    fail('gpt_threw');
                }
            };

            try {
                window.googletag.cmd.push(run);
            } catch (e) {
                fail('gpt_unavailable');
            }
        });
    }

    // --- restore keyboard/game focus after an ad (overlay steals activeElement) ---
    let savedFocusEl = null;
    let refocusOnWindowFocus = null;

    function rememberFocus() {
        try {
            const ae = document.activeElement;
            savedFocusEl = (ae && ae !== document.body) ? ae : null;
        } catch (e) { savedFocusEl = null; }
    }

    function pickGameSurface() {
        try {
            const mod = (window.unityInstance && window.unityInstance.Module) || window.Module;
            if (mod && mod.canvas && mod.canvas.isConnected) return mod.canvas;
        } catch (e) {}

        let best = null, bestArea = 0;
        try {
            document.querySelectorAll('canvas').forEach(c => {
                if (!c.isConnected) return;
                if (!c.offsetParent && getComputedStyle(c).position !== 'fixed') return;
                const r = c.getBoundingClientRect();
                const area = r.width * r.height;
                if (area > bestArea) { best = c; bestArea = area; }
            });
        } catch (e) {}
        if (best && bestArea > 10000) return best;

        if (savedFocusEl && savedFocusEl.isConnected && /^(CANVAS|IFRAME)$/.test(savedFocusEl.tagName)) {
            return savedFocusEl;
        }
        return document.querySelector('iframe') || best || null;
    }

    function focusGameSurface() {
        const el = pickGameSurface();
        if (!el) return;
        try {
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
            el.focus({ preventScroll: true });
            if (el.contentWindow) el.contentWindow.focus();
        } catch (e) {}
    }

    function restoreGameFocus() {
        try { window.focus(); } catch (e) {}
        focusGameSurface();
        // engines can reassert focus while the overlay is being torn down
        requestAnimationFrame(focusGameSurface);
        setTimeout(focusGameSurface, 80);
        setTimeout(focusGameSurface, 300);

        // if the ad's CTA opened a new tab, refocus when the user comes back
        if (refocusOnWindowFocus) window.removeEventListener('focus', refocusOnWindowFocus);
        refocusOnWindowFocus = () => {
            window.removeEventListener('focus', refocusOnWindowFocus);
            refocusOnWindowFocus = null;
            setTimeout(focusGameSurface, 0);
        };
        window.addEventListener('focus', refocusOnWindowFocus);
        setTimeout(() => {
            if (refocusOnWindowFocus) {
                window.removeEventListener('focus', refocusOnWindowFocus);
                refocusOnWindowFocus = null;
            }
        }, 60000);
    }

    function freezeGame() {
        if (document.getElementById('poki-gameplay-freeze')) return;
        rememberFocus();
        const overlay = document.createElement('div');
        overlay.id = 'poki-gameplay-freeze';
        document.body.appendChild(overlay);

        if (freezeTimer) clearTimeout(freezeTimer);
        freezeTimer = setTimeout(() => unfreezeGame(), 180000);

        document.querySelectorAll('audio, video').forEach(el => {
            try { el.muted = true; } catch(e){}
        });
        try {
            if (window.audioContext) window.audioContext.suspend();
        } catch (e) {}
    }

    function unfreezeGame() {
        if (freezeTimer) clearTimeout(freezeTimer);
        freezeTimer = null;

        ['#poki-gameplay-freeze', '.sdk-video-overlay', '.sdk-progress-bar', '.sdk-loading-overlay', '.sdk-applixir-container'].forEach(sel => {
            document.querySelectorAll(sel).forEach(el => el.remove());
        });

        document.querySelectorAll('audio, video').forEach(el => {
            try { el.muted = false; } catch(e){}
        });
        try {
            if (window.audioContext) window.audioContext.resume();
        } catch (e) {}

        restoreGameFocus();

        isAdActive = false;
        currentVideoElement = null;
    }

    async function showRewardedAd() {
        if (isAdActive) return true;

        isAdActive = true;
        console.log('[PokiSDK] Starting rewarded ad...');
        trackAdEvent('ad_requested', { ad_type: 'rewarded' });
        freezeGame();
        showLoadingIndicator();

        // Fallback chain: AppLixir (primary) -> GPT/AdSense (secondary) -> house
        // fallback video (last resort, always "completes" -- see playFallbackVideo).
        // Reward is granted only for a genuine completion of one of these three,
        // never unconditionally -- a TECHNICALLY-failed AppLixir attempt (no
        // fill, SDK blocked, init error, timeout -- none of it the visitor's
        // doing) falls through to GPT instead of leaving them with nothing.
        //
        // REWARD ON SKIP (owner, 2026-09-21): a genuine skip now STILL grants the reward.
        //
        // THIS DECISION HAS FLIPPED TWICE -- read before "fixing" it back. It was built as
        // reward-on-skip once, the owner chose "genuine skip = no reward" on 2026-09-14, and he
        // reversed it again on 2026-09-21. The current instruction is: always reward.
        //
        // We still DISTINGUISH a skip from a completion: the parent bridge keeps reporting the
        // truth (only status.type === "complete" sets rewarded), and the skip is tracked as its own
        // GA4 event (ad_skipped_rewarded) so the skip/completion ratio stays measurable. Nothing
        // here tells AppLixir an ad completed when it did not.
        //
        // A skip does NOT fall through to the rest of the ad chain: the visitor already chose to
        // bail, so showing them another ad and then rewarding them anyway is worse for everyone.
        // AppLixir's own integration guidance is "grant the reward only when status.type ===
        // complete", so this is a deliberate departure -- see the note in CLAUDE.md about the
        // completion-rate/eCPM risk.
        const USER_SKIP_REASONS = ['skip', 'skipped', 'userClose', 'manuallyEnded', 'adSkippedNoReward'];
        function isUserSkip(err) {
            const msg = (err && err.message) || '';
            // reason arrives as "applixir_bridge_<reason>" from the bridge, or
            // "applixir_<reason>" from the direct strategy.
            return USER_SKIP_REASONS.some((r) =>
                msg === 'applixir_bridge_' + r || msg === 'applixir_' + r);
        }

        let rewardGranted = false;

        try {
            console.log('[PokiSDK] Strategy: AppLixir (' + CONFIG.applixir.mode + ')');
            await (CONFIG.applixir.mode === 'bridge'
                ? showApplixirRewardedAd()
                : showApplixirDirectRewardedAd());
            console.log('[PokiSDK] ✅ AppLixir ad completed');
            rewardGranted = true;
            await hideLoadingIndicator();
            unfreezeGame();
        } catch (applixirError) {
            if (isUserSkip(applixirError)) {
                console.log('[PokiSDK] AppLixir ad skipped by the visitor -- rewarding anyway (owner policy 2026-09-21):', applixirError.message);
                trackAdEvent('ad_skipped_rewarded', { ad_source: 'applixir', ad_type: 'rewarded' });
                await hideLoadingIndicator();
                unfreezeGame();
                isAdActive = false;
                return true;
            }
            console.warn('[PokiSDK] AppLixir failed (not a skip), falling back to GPT:', applixirError.message);
            await hideLoadingIndicator();
            showLoadingIndicator();
            try {
                console.log('[PokiSDK] Strategy: Direct GPT');
                await showGPTRewardedAd();
                console.log('[PokiSDK] ✅ GPT ad completed');
                rewardGranted = true;
                await hideLoadingIndicator();
                unfreezeGame();
            } catch (gptError) {
                console.warn('[PokiSDK] GPT failed, using fallback:', gptError.message);
                await hideLoadingIndicator();
                await playFallbackVideo();
                // preserves pre-existing behavior: the house fallback video always
                // counts as a completed watch, since it has no network fill signal.
                rewardGranted = true;
            }
        } finally {
            isAdActive = false;
            unfreezeGame();
        }

        console.log('[PokiSDK] Rewarding user:', rewardGranted);

        return rewardGranted;
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
        gameInteractive: () => unfreezeGame(),
        gameplayStart: () => unfreezeGame(),
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

    injectStyles();
    loadFallbackList();
    initGPT();
    // preload the AppLixir SDK so the first ad request isn't waiting on the script
    if (CONFIG.applixir.mode === 'direct') loadApplixirSdk().catch(() => {});

    console.log("%c PokiSDK V6.3.0 Ready ", "background: #222; color: #fbff00; padding: 5px; border-radius: 3px;");
})();
