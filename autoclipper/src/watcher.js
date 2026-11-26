// ClipKit Auto Clipper: one Durable Object that watches Twitch chat for the
// streamers you pick and makes a clip when chat suddenly explodes.

const API = 'https://api.twitch.tv/helix';
const ID = 'https://id.twitch.tv/oauth2';
const EVENTSUB_WS = 'https://eventsub.wss.twitch.tv/ws';
const SCOPES = 'user:read:chat clips:edit editor:manage:clips';
const MAX_STREAMERS = 20;
const WINDOW = 600; // seconds of per-second chat stats kept per channel

// Words and emotes that chat spams when something hype or funny happens.
const HYPE_RE = /^(kekw|lulw?|omegalul|icant|pog\w*|monka\w*|wicked|lmf?ao+|ha(ha)+|holy|wtf|no{3,}|na+h{2,}|nah{2,}|💀+|😂+|🤣+|🔥+|\+\d|clip(ped|it)?|insane|crazy|omg|wha{2,}t+|what{2,}|gg+|ez|clap|kreygasm|bruh+|sheesh|w+)$/i;
const CLIP_RE = /\bclip(\s*it|ped|\s*that)?\b/i;

// min5 = how many different people must be chatting in 5 seconds; mult = how many times the normal amount
const SENS = {
  chill: { mult: 4.0, min5: 12 },
  normal: { mult: 3.0, min5: 8 },
  hyped: { mult: 2.2, min5: 5 }
};
// Chat bots whose messages never count
const BOTS = new Set(['nightbot', 'streamelements', 'moobot', 'fossabot', 'streamlabs', 'wizebot', 'botrixoficial', 'sery_bot', 'soundalerts', 'kofistreambot', 'blerp', 'pokemoncommunitygame', 'deepbot', 'phantombot', 'coebot', 'ankhbot', 'vivbot', 'own3d', 'tangiabot', 'streamstickers', 'commanderroot', 'frostytoolsdotcom', 'lolrankbot', 'creatisbot', 'songlistbot', 'kattah', 'buttsbot', 'pretzelrocks', 'restreambot', 'botisimo', 'stay_hydrated_bot', 'mixitupbot', 'supibot', 'electricallongboard', 'streamholics']);
// How long to ignore chat after events that make chat explode for reasons other than gameplay
const QUIET = { raid: 90, unraid: 30, sub_gift: 20, community_sub_gift: 45, gift_paid_upgrade: 15, prime_paid_upgrade: 10, pay_it_forward: 15, sub: 8, resub: 8, bits_badge_tier: 15, charity_donation: 20, announcement: 20, watch_streak: 5 };

const defaultCfg = () => ({ clientId: '', enabled: true, streamers: [], sensitivity: 'normal', clipLen: 30, maxPerStream: 5, cooldown: 120 });

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function randomKey() {
  const b = new Uint8Array(18); crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

class ChannelStats {
  constructor() {
    this.n = new Uint16Array(WINDOW); this.h = new Uint16Array(WINDOW); this.c = new Uint16Array(WINDOW);
    this.tokens = Array.from({ length: WINDOW }, () => null);
    this.people = Array.from({ length: WINDOW }, () => null);
    this.hypers = Array.from({ length: WINDOW }, () => null);
    this.askers = Array.from({ length: WINDOW }, () => null);
    this.sec = 0; this.base = null; this.seen = 0; this.lastClip = 0; this.quietUntil = 0; this.lastU5 = 0; this.warmSum = 0;
  }
  union(arr, now, secs) {
    const all = new Set();
    for (let k = 0; k < secs; k++) { const s = arr[(now - k + WINDOW) % WINDOW]; if (s) for (const x of s) all.add(x); }
    return all.size;
  }
  roll(now) {
    if (!this.sec) { this.sec = now; return; }
    for (let s = this.sec + 1; s <= now && s - this.sec <= WINDOW; s++) {
      const i = s % WINDOW; this.n[i] = 0; this.h[i] = 0; this.c[i] = 0; this.tokens[i] = null; this.people[i] = null; this.hypers[i] = null; this.askers[i] = null;
    }
    if (now > this.sec) this.sec = now;
  }
  add(now, who, hypeTokens, isClip) {
    this.roll(now);
    const i = now % WINDOW;
    this.n[i]++;
    (this.people[i] || (this.people[i] = new Set())).add(who);
    if (isClip) (this.askers[i] || (this.askers[i] = new Set())).add(who);
    if (hypeTokens.length) {
      this.h[i]++;
      (this.hypers[i] || (this.hypers[i] = new Set())).add(who);
      const m = this.tokens[i] || (this.tokens[i] = new Map());
      for (const t of hypeTokens) m.set(t, (m.get(t) || 0) + 1);
    }
    if (isClip) this.c[i]++;
  }
  sum(arr, now, secs) { let s = 0; for (let k = 0; k < secs; k++) s += arr[(now - k + WINDOW) % WINDOW]; return s; }
  top(now, secs) {
    const all = new Map();
    for (let k = 0; k < secs; k++) { const m = this.tokens[(now - k + WINDOW) % WINDOW]; if (m) for (const [t, v] of m) all.set(t, (all.get(t) || 0) + v); }
    return [...all.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }
}

export class Watcher {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.st = ctx.storage;
    this.ws = null; this.session = null; this.subs = new Map(); this.stats = new Map();
    this.tickTimer = null; this.lastWsAt = 0; this.keepaliveSec = 10;
    this.refreshing = null; this.connecting = null; this.welcomeWait = null; this.device = null; this.trendCache = new Map(); this.gameCache = new Map();
    this.ready = this.load();
  }

  async load() {
    this.cfg = { ...defaultCfg(), ...((await this.st.get('cfg')) || {}) };
    this.auth = (await this.st.get('auth')) || null;
    this.clips = (await this.st.get('clips')) || [];
    this.log = (await this.st.get('log')) || [];
    this.live = (await this.st.get('live')) || {};
    this.key = (await this.st.get('key')) || null;
  }

  now() { return Date.now(); }
  addLog(text) {
    this.log.unshift({ at: this.now(), text });
    if (this.log.length > 60) this.log.length = 60;
    this.st.put('log', this.log);
  }
  async kick(ms = 1000) {
    const cur = await this.st.getAlarm();
    if (!cur || cur > this.now() + ms) await this.st.setAlarm(this.now() + ms);
  }

  /* ---------------- HTTP API for the control page ---------------- */
  async fetch(req) {
    await this.ready;
    const url = new URL(req.url), path = url.pathname, method = req.method;
    const body = method === 'POST' ? await req.json().catch(() => ({})) : {};
    const given = req.headers.get('x-clipkit-key') || '';
    try {
      if (path === '/api/setup' && method === 'POST') {
        if (this.key && given !== this.key) return json({ error: 'This auto clipper is already set up. Use your access key.' }, 403);
        const cid = String(body.clientId || '').trim();
        if (!/^[a-z0-9]{20,40}$/i.test(cid)) return json({ error: "That doesn't look like a Twitch Client ID." }, 400);
        if (cid !== this.cfg.clientId) { this.cfg.clientId = cid; this.auth = null; await this.st.delete('auth'); }
        if (!this.key) { this.key = randomKey(); await this.st.put('key', this.key); }
        await this.st.put('cfg', this.cfg);
        return json({ key: this.key });
      }
      if (!this.key) return json({ unclaimed: true });
      if (given !== this.key) return json({ error: 'Wrong or missing access key.' }, 401);

      if (path === '/api/state') return json(this.state());
      if (path === '/api/auth/start' && method === 'POST') return json(await this.authStart());
      if (path === '/api/auth/poll' && method === 'POST') return json(await this.authPoll());
      if (path === '/api/logout' && method === 'POST') { await this.closeWs(); this.auth = null; await this.st.delete('auth'); return json({ ok: true }); }
      if (path === '/api/streamers/add' && method === 'POST') return json(await this.addStreamer(body.login));
      if (path === '/api/streamers/remove' && method === 'POST') {
        this.cfg.streamers = this.cfg.streamers.filter((s) => s.id !== body.id);
        await this.st.put('cfg', this.cfg); await this.kick(); return json({ ok: true });
      }
      if (path === '/api/config' && method === 'POST') {
        const c = this.cfg;
        if (body.sensitivity in SENS) c.sensitivity = body.sensitivity;
        if ([15, 20, 30, 45, 60].includes(+body.clipLen)) c.clipLen = +body.clipLen;
        if ([1, 3, 5, 10, 20].includes(+body.maxPerStream)) c.maxPerStream = +body.maxPerStream;
        if ([60, 120, 300, 600].includes(+body.cooldown)) c.cooldown = +body.cooldown;
        if (typeof body.enabled === 'boolean') c.enabled = body.enabled;
        await this.st.put('cfg', c); await this.kick(); return json({ ok: true });
      }
      if (path === '/api/clip-now' && method === 'POST') {
        const s = this.cfg.streamers.find((x) => x.id === body.id);
        if (!s) return json({ error: 'Unknown streamer' }, 400);
        if (!this.live[s.id]) return json({ error: `${s.name} isn't live right now.` }, 400);
        return json(await this.createClip(s, 'You tapped Clip now', [], true));
      }
      if (path === '/api/clips/download' && method === 'POST') return json(await this.download(body.id));
      if (path === '/api/trending') return json(await this.trending(url.searchParams));
      if (path === '/api/clips/remove' && method === 'POST') {
        this.clips = this.clips.filter((c) => c.id !== body.id); await this.st.put('clips', this.clips); return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status && e.status < 500 ? e.status : 500);
    }
  }

  state() {
    const nowS = Math.floor(this.now() / 1000);
    return {
      clientId: !!this.cfg.clientId,
      connected: !!(this.auth && !this.auth.broken), login: this.auth && this.auth.login, broken: !!(this.auth && this.auth.broken),
      cfg: { enabled: this.cfg.enabled, sensitivity: this.cfg.sensitivity, clipLen: this.cfg.clipLen, maxPerStream: this.cfg.maxPerStream, cooldown: this.cfg.cooldown },
      chat: !!(this.ws && this.session),
      streamers: this.cfg.streamers.map((s) => {
        const L = this.live[s.id], st = this.stats.get(s.id);
        const rate = st ? st.lastU5 : 0;
        return { ...s, live: !!L, title: L && L.title, game: L && L.game, viewers: L && L.viewers, since: L && L.since,
          rate: Math.round(rate * 10) / 10, base: st && st.base != null ? Math.round(st.base * 10) / 10 : null,
          clips: L ? this.clips.filter((c) => c.broadcaster_id === s.id && c.streamKey === L.since).length : 0 };
      }),
      clips: this.clips.slice(0, 80),
      log: this.log.slice(0, 40)
    };
  }

  /* ---------------- Twitch sign-in (device code, no secret needed) ---------------- */
  async authStart() {
    if (!this.cfg.clientId) throw new Error('Add your Twitch Client ID first.');
    const r = await fetch(ID + '/device', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.cfg.clientId, scopes: SCOPES }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message ? `Twitch said: ${j.message}. Check that your app's Client Type is Public.` : 'Twitch refused the sign-in.');
    this.device = { code: j.device_code, until: this.now() + j.expires_in * 1000 };
    return { user_code: j.user_code, verification_uri: j.verification_uri, interval: j.interval || 5, expires_in: j.expires_in };
  }
  async authPoll() {
    if (!this.device) return { error: 'Start the sign-in again.' };
    if (this.now() > this.device.until) { this.device = null; return { error: 'The code expired. Start again.' }; }
    const r = await fetch(ID + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, scopes: SCOPES, device_code: this.device.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (/pending/i.test(j.message || '')) return { pending: true };
      if (/denied/i.test(j.message || '')) { this.device = null; return { error: 'You declined on Twitch. Start again if that was a mistake.' }; }
      return { error: j.message || 'Sign-in failed.' };
    }
    this.device = null;
    this.auth = { access: j.access_token, refresh: j.refresh_token, expiresAt: this.now() + (j.expires_in || 3600) * 1000 };
    const v = await fetch(ID + '/validate', { headers: { authorization: 'OAuth ' + this.auth.access } }).then((x) => x.json());
    this.auth.userId = v.user_id; this.auth.login = v.login;
    await this.st.put('auth', this.auth);
    this.addLog(`Connected to Twitch as ${v.login}.`);
    await this.kick();
    return { ok: true, login: v.login };
  }
  async refresh(force) {
    if (!this.auth) throw new Error('Not connected to Twitch.');
    if (this.auth.broken) throw new Error('Twitch sign-in expired. Connect Twitch again.');
    if (!force && this.auth.expiresAt - this.now() > 10 * 60 * 1000) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const r = await fetch(ID + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.auth.refresh, client_id: this.cfg.clientId }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        this.auth.broken = true; await this.st.put('auth', this.auth);
        this.addLog('Twitch sign-in expired. Open the page and connect Twitch again.');
        throw new Error('Twitch sign-in expired. Connect Twitch again.');
      }
      this.auth.access = j.access_token; this.auth.refresh = j.refresh_token || this.auth.refresh;
      this.auth.expiresAt = this.now() + (j.expires_in || 3600) * 1000;
      await this.st.put('auth', this.auth);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async helix(path, { method = 'GET', query, body } = {}) {
    await this.refresh(false);
    const u = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) for (const x of [].concat(v)) u.searchParams.append(k, x);
    const go = () => fetch(u.toString(), { method, headers: { 'client-id': this.cfg.clientId, authorization: 'Bearer ' + this.auth.access, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let r = await go();
    if (r.status === 401) { await this.refresh(true); r = await go(); }
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || `Twitch error ${r.status}`); e.status = r.status; throw e; }
    return j;
  }

  async addStreamer(login) {
    login = String(login || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0].toLowerCase();
    if (!/^[a-z0-9_]{2,25}$/.test(login)) throw new Error('Type a Twitch username, like shroud.');
    if (this.cfg.streamers.some((s) => s.login === login)) throw new Error('Already on your list.');
    if (this.cfg.streamers.length >= MAX_STREAMERS) throw new Error(`You can watch up to ${MAX_STREAMERS} streamers.`);
    const j = await this.helix('/users', { query: { login } });
    const u = j.data && j.data[0];
    if (!u) throw new Error(`No Twitch user named ${login}.`);
    const s = { id: u.id, login: u.login, name: u.display_name, avatar: u.profile_image_url };
    this.cfg.streamers.push(s); await this.st.put('cfg', this.cfg);
    this.addLog(`Now watching ${s.name}.`);
    await this.kick();
    return { ok: true, streamer: s };
  }

  /* ---------------- the watch loop ---------------- */
  async alarm() {
    await this.ready;
    let anyLive = false;
    try { anyLive = await this.cycle(); }
    catch (e) { this.addLog('Problem: ' + e.message); }
    finally { await this.st.setAlarm(this.now() + (anyLive ? 30000 : 60000)); }
  }
  async cycle() {
    if (!this.auth || this.auth.broken || !this.cfg.clientId || !this.cfg.streamers.length) { await this.closeWs(); return false; }
    const ids = this.cfg.streamers.map((s) => s.id);
    const j = await this.helix('/streams', { query: { user_id: ids, first: '100' } });
    const live = {};
    for (const s of j.data || []) if (s.type === 'live') live[s.user_id] = { since: s.started_at, title: s.title, game: s.game_name, viewers: s.viewer_count };
    for (const s of this.cfg.streamers) {
      if (live[s.id] && !this.live[s.id]) this.addLog(`${s.name} went live${live[s.id].game ? ' playing ' + live[s.id].game : ''}.`);
      if (!live[s.id] && this.live[s.id]) { this.addLog(`${s.name} went offline.`); this.stats.delete(s.id); }
    }
    this.live = live; await this.st.put('live', live);
    const want = this.cfg.enabled ? ids.filter((id) => live[id]) : [];
    if (want.length) { await this.ensureWs(); await this.syncSubs(want); await this.checkViewerClips(want); }
    else await this.closeWs();
    await this.checkClips();
    return want.length > 0;
  }

  async ensureWs() {
    if (this.ws && this.session && this.now() - this.lastWsAt < (this.keepaliveSec + 15) * 1000) return;
    if (this.ws) await this.closeWs();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const ws = await this.openWs(EVENTSUB_WS);
      this.ws = ws; this.session = null; this.subs.clear();
      await new Promise((res, rej) => {
        const t = setTimeout(() => { this.welcomeWait = null; rej(new Error('Twitch chat connection timed out.')); }, 10000);
        this.welcomeWait = () => { clearTimeout(t); this.welcomeWait = null; res(); };
      });
      if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), 1000);
      this.addLog('Connected to Twitch chat.');
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async openWs(url) {
    const resp = await fetch(url, { headers: { upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) throw new Error("Couldn't open the Twitch chat connection.");
    ws.accept();
    ws.addEventListener('message', (e) => { try { this.onWs(ws, JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))); } catch (err) {} });
    const gone = () => { if (this.ws === ws) { this.ws = null; this.session = null; this.subs.clear(); } };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    return ws;
  }
  async closeWs() {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    const ws = this.ws; this.ws = null; this.session = null; this.subs.clear();
    if (ws) { try { ws.close(1000, 'done'); } catch (e) {} }
  }
  onWs(ws, m) {
    this.lastWsAt = this.now();
    const type = m.metadata && m.metadata.message_type;
    if (type === 'session_welcome') {
      this.session = m.payload.session.id;
      this.keepaliveSec = m.payload.session.keepalive_timeout_seconds || 10;
      if (ws !== this.ws) { const old = this.ws; this.ws = ws; if (old) { try { old.close(1000, 'reconnected'); } catch (e) {} } }
      if (this.welcomeWait) this.welcomeWait();
    } else if (type === 'session_reconnect') {
      const url = m.payload.session.reconnect_url.replace(/^wss:/, 'https:');
      this.openWs(url).catch(() => this.closeWs());
    } else if (type === 'notification') {
      if (m.payload.subscription.type === 'channel.chat.message') this.onChat(m.payload.event);
      else if (m.payload.subscription.type === 'channel.chat.notification') this.onNotice(m.payload.event);
    } else if (type === 'revocation') {
      const sub = m.payload.subscription;
      for (const [k, v] of this.subs) if (v === sub.id) this.subs.delete(k);
      this.addLog(`Twitch stopped a chat subscription (${sub.status}).`);
    }
  }
  async syncSubs(want) {
    for (const id of want) {
      for (const type of ['channel.chat.message', 'channel.chat.notification']) {
        const k = id + '|' + type;
        if (this.subs.has(k)) continue;
        try {
          const j = await this.helix('/eventsub/subscriptions', { method: 'POST', body: { type, version: '1', condition: { broadcaster_user_id: id, user_id: this.auth.userId }, transport: { method: 'websocket', session_id: this.session } } });
          this.subs.set(k, j.data && j.data[0] && j.data[0].id);
        } catch (e) {
          if (e.status === 409) this.subs.set(k, 'existing');
          else if (type === 'channel.chat.message') this.addLog(`Couldn't watch chat for ${this.nameOf(id)}: ${e.message}`);
        }
      }
    }
    for (const [k, subId] of this.subs) {
      const id = k.split('|')[0];
      if (want.includes(id)) continue;
      this.subs.delete(k);
      if (subId && subId !== 'existing') { try { await this.helix('/eventsub/subscriptions', { method: 'DELETE', query: { id: subId } }); } catch (e) {} }
    }
  }
  nameOf(id) { const s = this.cfg.streamers.find((x) => x.id === id); return s ? s.name : id; }

  statsFor(id) { let st = this.stats.get(id); if (!st) { st = new ChannelStats(); this.stats.set(id, st); } return st; }
  quiet(id, secs) { const st = this.statsFor(id); st.quietUntil = Math.max(st.quietUntil, this.now() + secs * 1000); }
  onNotice(ev) {
    const id = ev.broadcaster_user_id; if (!this.live[id]) return;
    const secs = QUIET[ev.notice_type];
    if (secs) this.quiet(id, secs);
  }
  onChat(ev) {
    const id = ev.broadcaster_user_id; if (!this.live[id]) return;
    const login = String(ev.chatter_user_login || '').toLowerCase();
    const text = (ev.message && ev.message.text) || '';
    if (ev.chatter_user_id && ev.chatter_user_id === id) return; // the streamer
    if (BOTS.has(login) || /bot$/.test(login)) return;
    if (/^\s*!/.test(text)) return; // commands like !enter, !discord
    if (ev.cheer && ev.cheer.bits >= 500) this.quiet(id, 20);
    const st = this.statsFor(id);
    const words = text.split(/\s+/).filter(Boolean);
    const hype = [];
    for (const w of words) { const t = w.replace(/[!?.,]+$/, ''); if (t && HYPE_RE.test(t)) hype.push(t.length > 18 ? t.slice(0, 18) : t); }
    st.add(Math.floor(this.now() / 1000), ev.chatter_user_id || login || Math.random(), hype, CLIP_RE.test(text));
  }

  tick() {
    if (!this.cfg.enabled || !this.ws) return;
    const nowS = Math.floor(this.now() / 1000), S = SENS[this.cfg.sensitivity] || SENS.normal;
    for (const [id, st] of this.stats) {
      const L = this.live[id]; if (!L) continue;
      st.roll(nowS);
      // count PEOPLE, not messages, so a few spammers can't fake a spike
      const u5 = st.union(st.people, nowS - 1, 5), hp5 = st.union(st.hypers, nowS - 1, 5), ask10 = st.union(st.askers, nowS - 1, 10);
      st.lastU5 = u5;
      st.seen++;
      if (st.seen <= 60) { st.warmSum += u5; st.base = st.warmSum / st.seen; continue; } // learn normal first
      const quiet = this.now() < st.quietUntil;
      const spiking = u5 > st.base * 1.5;
      st.base += (u5 - st.base) * (quiet ? 1 / 20 : spiking ? 1 / 900 : 1 / 120);
      if (quiet) continue; // raid, gifted subs, etc.
      const base = Math.max(st.base, 1);
      const fast = u5 >= S.min5 && u5 >= base * S.mult;
      const hypeShare = u5 ? hp5 / u5 : 0;
      const asked = ask10 >= 3 && u5 >= S.min5 / 2;
      if (!((fast && (hypeShare >= 0.25 || u5 >= base * S.mult * 1.6)) || asked)) continue;
      const why = asked && !fast ? `${ask10} people asked for a clip` : `${u5} people reacting at once (${(u5 / base).toFixed(1)}× normal)`;
      this.tryClip(id, why, st.top(nowS - 1, 10));
    }
  }
  canClip(id) {
    const L = this.live[id], st = this.statsFor(id);
    if (!L || !this.cfg.enabled) return false;
    if (this.now() - st.lastClip < this.cfg.cooldown * 1000) return false;
    return this.clips.filter((c) => c.broadcaster_id === id && c.streamKey === L.since).length < this.cfg.maxPerStream;
  }
  tryClip(id, why, top, duration) {
    if (!this.canClip(id)) return;
    this.statsFor(id).lastClip = this.now();
    const s = this.cfg.streamers.find((x) => x.id === id);
    if (s) this.createClip(s, why, top, false, duration).catch((e) => this.addLog(`Clip failed for ${s.name}: ${e.message}`));
  }
  // When several different viewers clip within the last minute, something good just happened
  async checkViewerClips(ids) {
    const since = new Date(this.now() - 90 * 1000).toISOString();
    await Promise.all(ids.map(async (id) => {
      if (!this.canClip(id)) return;
      let j; try { j = await this.helix('/clips', { query: { broadcaster_id: id, started_at: since, first: '20' } }); } catch (e) { return; }
      const fresh = (j.data || []).filter((c) => c.creator_id !== this.auth.userId && this.now() - Date.parse(c.created_at) < 75 * 1000);
      const people = new Set(fresh.map((c) => c.creator_id));
      if (people.size >= 2) this.tryClip(id, `${people.size} viewers clipped this moment`, [], 60);
    }));
  }

  async createClip(s, why, top, manual, duration) {
    const L = this.live[s.id] || {};
    const title = (top && top.length ? `${top[0][0]} moment` : 'Hype moment').slice(0, 100);
    const j = await this.helix('/clips', { method: 'POST', query: { broadcaster_id: s.id, duration: String(Math.max(duration || 0, this.cfg.clipLen)), title } });
    const d = j.data && j.data[0];
    if (!d) throw new Error('Twitch did not return a clip.');
    const rec = { id: d.id, edit_url: d.edit_url, url: `https://clips.twitch.tv/${d.id}`, broadcaster_id: s.id, login: s.login, name: s.name,
      at: this.now(), why, top: (top || []).map(([t, n]) => `${t} ×${n}`), game: L.game || '', streamKey: L.since || '', status: 'processing', manual: !!manual };
    this.clips.unshift(rec); if (this.clips.length > 200) this.clips.length = 200;
    await this.st.put('clips', this.clips);
    this.addLog(`Clipped ${s.name}: ${why}.`);
    await this.kick(20000);
    return { ok: true, clip: rec };
  }
  async checkClips() {
    const pending = this.clips.filter((c) => c.status === 'processing');
    if (!pending.length) return;
    const j = await this.helix('/clips', { query: { id: pending.slice(0, 100).map((c) => c.id) } });
    const found = new Map((j.data || []).map((c) => [c.id, c]));
    let changed = false;
    for (const c of pending) {
      const f = found.get(c.id);
      if (f) { c.status = 'ready'; c.thumb = f.thumbnail_url; c.duration = f.duration; c.url = f.url || c.url; changed = true; }
      else if (this.now() - c.at > 90000) { c.status = 'failed'; changed = true; }
    }
    if (changed) await this.st.put('clips', this.clips);
  }

  /* ---------------- Trending: popular clips other people already made ---------------- */
  async trending(q) {
    const range = ({ '24h': 24, '3d': 72, '7d': 168 })[q.get('range')] || 24;
    const scope = q.get('scope') === 'game' ? 'game' : 'streamers';
    const gameName = String(q.get('game') || '').trim();
    const cacheKey = `${scope}|${range}|${gameName.toLowerCase()}|${this.cfg.streamers.map((s) => s.id).join(',')}`;
    const hit = this.trendCache.get(cacheKey);
    if (hit && this.now() - hit.at < 5 * 60 * 1000) return { ...hit.data, cached: true };
    const started = new Date(this.now() - range * 3600 * 1000).toISOString(), ended = new Date(this.now()).toISOString();
    let raw = [], game = null;
    if (scope === 'game') {
      if (!gameName) throw new Error('Type a game name, like Valorant.');
      game = this.gameCache.get(gameName.toLowerCase());
      if (!game) {
        const g = await this.helix('/games', { query: { name: gameName } });
        let d = g.data && g.data[0];
        if (!d) { const s = await this.helix('/search/categories', { query: { query: gameName, first: '1' } }); d = s.data && s.data[0]; }
        if (!d) throw new Error(`Couldn't find a game called ${gameName}.`);
        game = { id: d.id, name: d.name }; this.gameCache.set(gameName.toLowerCase(), game);
      }
      const j = await this.helix('/clips', { query: { game_id: game.id, started_at: started, ended_at: ended, first: '100' } });
      raw = j.data || [];
    } else {
      if (!this.cfg.streamers.length) return { clips: [], note: 'Add streamers on the Auto clips tab first.' };
      const lists = await Promise.all(this.cfg.streamers.map((s) =>
        this.helix('/clips', { query: { broadcaster_id: s.id, started_at: started, ended_at: ended, first: '25' } }).then((j) => j.data || []).catch(() => [])));
      raw = lists.flat();
    }
    const mine = new Set(this.clips.map((c) => c.id));
    const clips = raw.map((c) => {
      const hours = Math.max(0.25, (this.now() - Date.parse(c.created_at)) / 3600000);
      return { id: c.id, url: c.url, title: c.title, name: c.broadcaster_name, by: c.creator_name, views: c.view_count, created: c.created_at,
        perHour: Math.round(c.view_count / hours), duration: c.duration, thumb: c.thumbnail_url, video: c.video_id || '', vodOffset: c.vod_offset == null ? null : c.vod_offset, mine: mine.has(c.id) };
    });
    const data = { clips, game: game && game.name, at: this.now() };
    this.trendCache.set(cacheKey, { at: this.now(), data });
    if (this.trendCache.size > 30) this.trendCache.delete(this.trendCache.keys().next().value);
    return data;
  }

  async download(id) {
    const c = this.clips.find((x) => x.id === id);
    if (!c) throw new Error('Clip not found.');
    try {
      const j = await this.helix('/clips/downloads', { query: { editor_id: this.auth.userId, broadcaster_id: c.broadcaster_id, clip_id: id } });
      const d = j.data && j.data[0];
      if (d && (d.landscape_download_url || d.portrait_download_url)) return { url: d.landscape_download_url || d.portrait_download_url, portrait: d.portrait_download_url };
      return { manual: true };
    } catch (e) {
      if (e.status === 403 || e.status === 401) return { manual: true };
      throw e;
    }
  }
}
