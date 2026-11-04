// ==UserScript==
// @name         YouTube Notifications Modal
// @namespace    https://github.com/matthewwyndham
// @version      0.2.0
// @description  Shows your YouTube notifications in a large modal grid, with infinite scroll, "load all" and a filter.
// @homepageURL  https://github.com/matthewwyndham/youtube-notification-modal
// @supportURL   https://github.com/matthewwyndham/youtube-notification-modal/issues
// @downloadURL  https://raw.githubusercontent.com/matthewwyndham/youtube-notification-modal/main/youtube-notifications-modal.user.js
// @updateURL    https://raw.githubusercontent.com/matthewwyndham/youtube-notification-modal/main/youtube-notifications-modal.user.js
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // The bell menu loads its list with this browse ID, then pages with continuation tokens.
  const BROWSE_ID = 'FEnotifications_inbox';
  const MAX_ITEMS = 2000;

  // ---------------------------------------------------------------------------
  // Parsing
  //
  // YouTube renames its renderers often, so the parser does not hard-code a path to the list.
  // It finds the repeated "*Renderer" / "*ViewModel" objects that each carry a link and a
  // message, and pulls the fields out of each one by shape.
  // ---------------------------------------------------------------------------

  const isObj = (v) => v !== null && typeof v === 'object';
  const SKIP_KEYS = /menu|accessibility|a11y|tooltip|logging|tracking|^button/i;
  const WRAPPER_KINDS = /section|list|shelf|grid|continuation|menu|header|tab|page|results|chip/i;
  const TIME_RE =
    /\b(ago|just now|yesterday)\b|^\d+\s*(s|sec|second|m|min|minute|h|hr|hour|d|day|w|wk|week|mo|month|y|yr|year)s?\b/i;

  // Calls visit(node, key, inArray) on every object and array. Returning false skips the subtree.
  function walk(node, visit, key, inArray) {
    if (!isObj(node)) return;
    if (visit(node, key, inArray) === false) return;
    if (Array.isArray(node)) for (const v of node) walk(v, visit, key, true);
    else for (const k in node) walk(node[k], visit, k, false);
  }

  function textOf(t) {
    if (typeof t === 'string') return t;
    if (!isObj(t)) return '';
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text ?? '').join('');
    if (typeof t.content === 'string') return t.content;
    return '';
  }

  // Picks a thumbnail big enough for a grid card without loading the largest size.
  function pickImage(set) {
    const sorted = set.filter((i) => i?.url).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    const img = sorted.find((i) => (i.width ?? 0) >= 320) ?? sorted.at(-1);
    if (!img) return null;
    return img.url.startsWith('//') ? `https:${img.url}` : img.url;
  }

  function extractItem(kind, r) {
    const texts = [];
    const imageSets = [];
    let url = null;
    let read = null;
    let id = typeof r.notificationId === 'string' ? r.notificationId : null;

    walk(r, (node, key) => {
      if (key && SKIP_KEYS.test(key)) return false;
      if (Array.isArray(node)) return undefined;
      if (!url) {
        if (key === 'webCommandMetadata' && typeof node.url === 'string' && node.url !== '/') url = node.url;
        else if (key === 'watchEndpoint' && node.videoId) url = `/watch?v=${node.videoId}`;
      }
      if (read === null) {
        if (typeof node.read === 'boolean') read = node.read;
        else if (typeof node.isRead === 'boolean') read = node.isRead;
        else if (typeof node.isUnread === 'boolean') read = !node.isUnread;
      }
      if (!id && typeof node.notificationId === 'string') id = node.notificationId;
      const imgs = Array.isArray(node.thumbnails) ? node.thumbnails : Array.isArray(node.sources) ? node.sources : null;
      if (imgs?.some((i) => i?.url)) {
        imageSets.push({ key, set: imgs });
        return false;
      }
      if (typeof node.simpleText === 'string' || Array.isArray(node.runs) || typeof node.content === 'string') {
        const text = textOf(node).trim();
        if (text) texts.push({ key: key ?? '', text });
        return false;
      }
      return undefined;
    });

    // Video thumbnails come from i.ytimg.com; channel avatars from yt3.ggpht.com.
    let thumb = null;
    let avatar = null;
    for (const { set } of imageSets) {
      const u = pickImage(set);
      if (!u) continue;
      if (/ytimg\.com/.test(u)) thumb ??= u;
      else avatar ??= u;
    }

    const timeEntry =
      texts.find((t) => /time/i.test(t.key)) ?? texts.find((t) => t.text.length < 40 && TIME_RE.test(t.text));
    const message = texts
      .filter((t) => t !== timeEntry)
      .reduce((best, t) => (t.text.length > best.length ? t.text : best), '');

    return {
      id: id ?? `${url}|${message}`,
      kind,
      url,
      message,
      time: timeEntry?.text ?? '',
      thumb,
      avatar,
      read,
    };
  }

  function findContinuation(resp) {
    const tokenOf = (n, k) =>
      (k === 'continuationCommand' && n.token) || (k === 'nextContinuationData' && n.continuation) || null;
    let fromItem = null;
    let any = null;
    walk(resp, (node, key) => {
      if (Array.isArray(node)) return undefined;
      if (key === 'continuationItemRenderer') {
        walk(node, (n, k) => {
          const t = !Array.isArray(n) && tokenOf(n, k);
          if (t) fromItem = t;
        });
        return false;
      }
      const t = tokenOf(node, key);
      if (t) any = t;
      return undefined;
    });
    return fromItem ?? any;
  }

  function parsePage(resp) {
    const byKind = new Map();
    walk(resp, (node, _key, inArray) => {
      if (!inArray || Array.isArray(node)) return undefined;
      const keys = Object.keys(node);
      if (keys.length !== 1 || !/(Renderer|ViewModel)$/.test(keys[0])) return undefined;
      const kind = keys[0];
      if (WRAPPER_KINDS.test(kind)) return undefined;
      const item = extractItem(kind, node[kind]);
      if (!item.url || !item.message) return undefined;
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(item);
      return false;
    });

    let best = byKind.has('notificationRenderer') ? 'notificationRenderer' : null;
    if (!best) for (const [k, v] of byKind) if (!best || v.length > byKind.get(best).length) best = k;
    return { items: best ? byKind.get(best) : [], kind: best, continuation: findContinuation(resp) };
  }

  if (globalThis.__YTNM_TEST__) {
    globalThis.__YTNM_TEST__ = { parsePage };
    return;
  }

  // ---------------------------------------------------------------------------
  // InnerTube request
  // ---------------------------------------------------------------------------

  const cfg = (k) => window.ytcfg?.get?.(k) ?? window.ytcfg?.data_?.[k];

  function getCookie(name) {
    for (const part of document.cookie.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
    }
    return null;
  }

  async function sha1Hex(s) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Cookies alone get a signed-out answer from InnerTube; it also wants the SAPISID hash that
  // YouTube's own JS sends.
  async function authHeader() {
    const ts = Math.floor(Date.now() / 1000);
    const origin = location.origin;
    const schemes = [
      ['SAPISIDHASH', getCookie('SAPISID') ?? getCookie('__Secure-3PAPISID')],
      ['SAPISID1PHASH', getCookie('__Secure-1PAPISID')],
      ['SAPISID3PHASH', getCookie('__Secure-3PAPISID')],
    ];
    const parts = [];
    for (const [scheme, sid] of schemes) {
      if (sid) parts.push(`${scheme} ${ts}_${await sha1Hex(`${ts} ${sid} ${origin}`)}`);
    }
    return parts.join(' ');
  }

  async function browse(body) {
    const context = cfg('INNERTUBE_CONTEXT');
    if (!context) throw new Error('YouTube config (ytcfg) is not ready yet');
    const headers = {
      'Content-Type': 'application/json',
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
      'X-Youtube-Client-Version': cfg('INNERTUBE_CLIENT_VERSION') ?? context.client?.clientVersion ?? '',
      'X-Youtube-Bootstrap-Logged-In': 'true',
    };
    const visitor = cfg('VISITOR_DATA') ?? context.client?.visitorData;
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const pageId = cfg('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = pageId;
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;

    const res = await fetch('/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) throw new Error(`YouTube answered HTTP ${res.status}`);
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // State and loading
  // ---------------------------------------------------------------------------

  const freshState = (gen = 0) => ({
    gen,
    items: [],
    seen: new Set(),
    token: null,
    done: false,
    error: null,
    inflight: null,
    loadingAll: false,
    responses: [],
  });
  let state = freshState();

  function loadNext() {
    if (state.inflight) return state.inflight;
    if (state.done || state.error) return Promise.resolve();
    const s = state;
    s.inflight = (async () => {
      updateStatus();
      try {
        const data = await browse(s.token ? { continuation: s.token } : { browseId: BROWSE_ID });
        if (s !== state) return;
        // Keep the first page and the latest two for "Copy debug JSON".
        s.responses.push(data);
        if (s.responses.length > 3) s.responses.splice(1, 1);

        const { items, continuation } = parsePage(data);
        let added = 0;
        for (const it of items) {
          if (s.seen.has(it.id)) continue;
          s.seen.add(it.id);
          s.items.push(it);
          ui.grid.append(renderCard(it));
          added++;
        }
        if (!s.token && added === 0) {
          s.error =
            "Found no notifications in YouTube's response. Are you signed in? If so, YouTube changed its " +
            'format: click "Copy debug JSON" and share it so the parser can be fixed.';
        }
        if (!continuation || continuation === s.token || (s.token && added === 0)) s.done = true;
        s.token = continuation;
      } catch (err) {
        if (s === state) s.error = `${err.message}. Click Refresh to try again.`;
        console.error('[ytnm]', err);
      } finally {
        s.inflight = null;
        if (s === state) {
          applyFilter();
          setTimeout(maybeContinue, 0);
        }
      }
    })();
    return s.inflight;
  }

  // The IntersectionObserver fires only when visibility changes, so a page that leaves the
  // sentinel on screen would stall without this check.
  function maybeContinue() {
    if (!ui || ui.backdrop.hidden || state.done || state.error || state.loadingAll) return;
    const body = ui.body.getBoundingClientRect();
    const s = ui.sentinel.getBoundingClientRect();
    if (s.top < body.bottom + 600 && state.items.length < MAX_ITEMS) loadNext();
  }

  async function toggleLoadAll() {
    if (state.loadingAll) {
      state.loadingAll = false;
      updateStatus();
      return;
    }
    const s = state;
    s.loadingAll = true;
    updateStatus();
    while (s === state && s.loadingAll && !s.done && !s.error && s.items.length < MAX_ITEMS) {
      await loadNext();
      await new Promise((r) => setTimeout(r, 150));
    }
    s.loadingAll = false;
    if (s === state) updateStatus();
  }

  function refresh() {
    state = freshState(state.gen + 1);
    ui.grid.replaceChildren();
    loadNext();
  }

  async function copyDebug() {
    if (!state.responses.length) return;
    console.log('[ytnm] raw responses', state.responses);
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.responses, null, 1));
      flash('Copied. It holds your notification text, so skim it before sharing.');
    } catch {
      flash('Clipboard blocked. The responses are logged in the console as "[ytnm] raw responses".');
    }
  }

  // ---------------------------------------------------------------------------
  // UI (built with DOM calls: YouTube enforces Trusted Types, so innerHTML throws)
  // ---------------------------------------------------------------------------

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat().filter((c) => c != null && c !== false && c !== ''));
    return el;
  }

  function gridIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z');
    svg.append(path);
    return svg;
  }

  let ui = null;
  let prevOverflow = '';
  let flashTimer = 0;

  function buildUI() {
    const count = h('span', { class: 'ytnm-count' });
    const filter = h('input', {
      class: 'ytnm-filter',
      type: 'search',
      placeholder: 'Filter loaded notifications…',
      oninput: applyFilter,
    });
    const loadAllBtn = h('button', { class: 'ytnm-btn', onclick: toggleLoadAll }, 'Load all');
    const head = h(
      'div',
      { class: 'ytnm-head' },
      h('h2', {}, 'Notifications'),
      count,
      filter,
      loadAllBtn,
      h('button', { class: 'ytnm-btn', title: 'Reload from the newest', onclick: refresh }, 'Refresh'),
      h(
        'button',
        { class: 'ytnm-btn', title: 'Copy the raw API responses, to fix the parser', onclick: copyDebug },
        'Copy debug JSON',
      ),
      h('button', { class: 'ytnm-btn ytnm-close', title: 'Close (Esc)', 'aria-label': 'Close', onclick: close }, '✕'),
    );
    const grid = h('div', { class: 'ytnm-grid' });
    const status = h('div', { class: 'ytnm-status' });
    const sentinel = h('div', { class: 'ytnm-sentinel' });
    const body = h('div', { class: 'ytnm-body' }, grid, status, sentinel);
    const modal = h(
      'div',
      { class: 'ytnm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Notifications' },
      head,
      body,
    );
    const backdrop = h('div', { id: 'ytnm-backdrop', hidden: true }, modal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    // Keep YouTube's player hotkeys (k, j, space, f…) from firing while typing in the modal.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      modal.addEventListener(type, (e) => {
        if (e.key !== 'Escape') e.stopPropagation();
      });
    }
    document.body.append(backdrop);

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) maybeContinue();
      },
      { root: body, rootMargin: '600px' },
    );
    io.observe(sentinel);

    ui = { backdrop, body, grid, status, count, filter, loadAllBtn, sentinel };
  }

  function renderCard(it) {
    const unread = it.read === false;
    const thumb = h(
      'div',
      { class: 'ytnm-thumb' },
      it.thumb && h('img', { src: it.thumb, loading: 'lazy', alt: '' }),
      unread && h('span', { class: 'ytnm-dot', title: 'Unread' }),
    );
    const meta = h(
      'div',
      { class: 'ytnm-meta' },
      it.avatar ? h('img', { class: 'ytnm-avatar', src: it.avatar, loading: 'lazy', alt: '' }) : h('div', { class: 'ytnm-avatar' }),
      h(
        'div',
        { class: 'ytnm-text' },
        h('div', { class: 'ytnm-msg', title: it.message }, it.message),
        it.time && h('div', { class: 'ytnm-time' }, it.time),
      ),
    );
    const card = h(
      'a',
      { class: unread ? 'ytnm-card ytnm-unread' : 'ytnm-card', href: new URL(it.url, location.origin).href },
      thumb,
      meta,
    );
    card.dataset.search = `${it.message} ${it.time}`.toLowerCase();
    card.addEventListener('click', (e) => {
      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) close();
    });
    return card;
  }

  function applyFilter() {
    if (!ui) return;
    const q = ui.filter.value.trim().toLowerCase();
    for (const card of ui.grid.children) card.hidden = Boolean(q) && !card.dataset.search.includes(q);
    updateStatus();
  }

  function updateStatus() {
    if (!ui) return;
    const total = state.items.length;
    const shown = ui.filter.value.trim() ? [...ui.grid.children].filter((c) => !c.hidden).length : total;
    ui.count.textContent = shown === total ? `${total} loaded` : `${shown} of ${total} shown`;
    ui.loadAllBtn.textContent = state.loadingAll ? 'Stop' : 'Load all';
    ui.loadAllBtn.disabled = state.done || Boolean(state.error);
    if (state.error) ui.status.textContent = state.error;
    else if (state.inflight || state.loadingAll) ui.status.textContent = 'Loading…';
    else if (state.done) ui.status.textContent = total ? 'End of notifications.' : 'No notifications.';
    else if (total >= MAX_ITEMS) ui.status.textContent = `Stopped at ${MAX_ITEMS} notifications.`;
    else ui.status.textContent = '';
  }

  function flash(msg) {
    if (!ui) return;
    clearTimeout(flashTimer);
    ui.status.textContent = msg;
    flashTimer = setTimeout(updateStatus, 4000);
  }

  function open() {
    if (!ui) buildUI();
    if (!ui.backdrop.hidden) return;
    ui.backdrop.hidden = false;
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    ui.filter.focus({ preventScroll: true });
    if (!state.items.length && !state.done && !state.error) loadNext();
    else maybeContinue();
  }

  function close() {
    if (!ui || ui.backdrop.hidden) return;
    ui.backdrop.hidden = true;
    state.loadingAll = false;
    document.documentElement.style.overflow = prevOverflow;
  }

  const toggle = () => (ui && !ui.backdrop.hidden ? close() : open());

  // ---------------------------------------------------------------------------
  // Entry points: a masthead button beside the bell, and Alt+Shift+N (Option+Shift+N on a Mac)
  // ---------------------------------------------------------------------------

  function injectButton() {
    if (document.getElementById('ytnm-open')) return true;
    const buttons = document.querySelector('ytd-masthead #end #buttons');
    if (!buttons) return false;
    const btn = h(
      'button',
      { id: 'ytnm-open', title: 'All notifications (Alt+Shift+N)', 'aria-label': 'Open all notifications', onclick: toggle },
      gridIcon(),
    );
    const bell = buttons.querySelector('ytd-notification-topbar-button-renderer');
    if (bell) bell.before(btn);
    else buttons.prepend(btn);
    return true;
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN') {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      } else if (e.key === 'Escape' && ui && !ui.backdrop.hidden) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true,
  );

  const css = `
    #ytnm-backdrop {
      --ytnm-bg: #fff; --ytnm-fg: #0f0f0f; --ytnm-muted: #606060; --ytnm-card: #f2f2f2;
      --ytnm-card-hover: #e5e5e5; --ytnm-border: rgba(0,0,0,.12); --ytnm-accent: #065fd4;
      position: fixed; inset: 0; z-index: 2400; background: rgba(0,0,0,.6);
      display: flex; align-items: center; justify-content: center;
      font-family: "Roboto", "Arial", sans-serif;
    }
    html[dark] #ytnm-backdrop {
      --ytnm-bg: #0f0f0f; --ytnm-fg: #f1f1f1; --ytnm-muted: #aaa; --ytnm-card: #272727;
      --ytnm-card-hover: #3f3f3f; --ytnm-border: rgba(255,255,255,.14); --ytnm-accent: #3ea6ff;
    }
    #ytnm-backdrop[hidden] { display: none; }
    .ytnm-modal {
      width: min(96vw, 1900px); height: 92vh; display: flex; flex-direction: column; overflow: hidden;
      background: var(--ytnm-bg); color: var(--ytnm-fg); border-radius: 12px;
      box-shadow: 0 12px 48px rgba(0,0,0,.5);
    }
    .ytnm-head {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      padding: 12px 16px; border-bottom: 1px solid var(--ytnm-border);
    }
    .ytnm-head h2 { margin: 0 4px 0 0; font-size: 20px; font-weight: 600; }
    .ytnm-count { margin-right: auto; font-size: 13px; color: var(--ytnm-muted); }
    .ytnm-filter {
      width: min(320px, 40vw); padding: 8px 14px; font-size: 14px; outline: none;
      border: 1px solid var(--ytnm-border); border-radius: 18px;
      background: var(--ytnm-card); color: var(--ytnm-fg);
    }
    .ytnm-filter:focus { border-color: var(--ytnm-accent); }
    .ytnm-btn {
      padding: 8px 14px; font-size: 14px; font-weight: 500; cursor: pointer;
      border: 0; border-radius: 18px; background: var(--ytnm-card); color: var(--ytnm-fg);
    }
    .ytnm-btn:hover:not(:disabled) { background: var(--ytnm-card-hover); }
    .ytnm-btn:disabled { opacity: .45; cursor: default; }
    .ytnm-body { flex: 1; overflow: auto; padding: 16px; }
    .ytnm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
    .ytnm-card {
      display: flex; flex-direction: column; gap: 8px; padding: 8px;
      border-radius: 10px; color: inherit; text-decoration: none;
    }
    .ytnm-card[hidden] { display: none; }
    .ytnm-card:hover { background: var(--ytnm-card); }
    .ytnm-thumb {
      position: relative; aspect-ratio: 16 / 9; overflow: hidden;
      border-radius: 8px; background: var(--ytnm-card);
    }
    .ytnm-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .ytnm-dot {
      position: absolute; top: 8px; left: 8px; width: 10px; height: 10px; border-radius: 50%;
      background: var(--ytnm-accent); box-shadow: 0 0 0 2px var(--ytnm-bg);
    }
    .ytnm-meta { display: flex; align-items: flex-start; gap: 10px; }
    .ytnm-avatar { flex: none; width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: var(--ytnm-card); }
    .ytnm-text { min-width: 0; }
    .ytnm-msg {
      font-size: 14px; line-height: 20px; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    }
    .ytnm-unread .ytnm-msg { font-weight: 500; }
    .ytnm-time { margin-top: 4px; font-size: 12px; color: var(--ytnm-muted); }
    .ytnm-status { padding: 16px; text-align: center; font-size: 13px; color: var(--ytnm-muted); }
    .ytnm-sentinel { height: 1px; }
    #ytnm-open {
      display: inline-flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; margin-right: 4px; padding: 0; cursor: pointer;
      border: 0; border-radius: 50%; background: transparent; color: #0f0f0f;
    }
    html[dark] #ytnm-open { color: #f1f1f1; }
    #ytnm-open:hover { background: rgba(0,0,0,.1); }
    html[dark] #ytnm-open:hover { background: rgba(255,255,255,.2); }
  `;
  document.head.append(h('style', { id: 'ytnm-style', textContent: css }));

  // The masthead renders after document-idle on a cold load, and SPA navigation can re-stamp it.
  let tries = 0;
  const timer = setInterval(() => {
    if (injectButton() || ++tries > 40) clearInterval(timer);
  }, 500);
  document.addEventListener('yt-navigate-finish', injectButton);

  window.ytnm = { open, close, parsePage, get state() { return state; } };
})();
