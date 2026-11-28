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
// Words chat uses when a streamer says something real or deep (for Talk-style streamers)
const AGREE_TOK = /^(real+|fr+|frfr|facts?|true+|truth|wise|deep|goat|based|preach|valid|agreed?|ong|this+|💯+|🙏+|😭+|❤️+|❤+|🫡+|👏+|🥹+|🫶+|👍+|\+1|w+)$/i;
const STRONG_AGREE = /^(fr+|frfr|facts?|preach|goat|based|ong|agreed?|💯+|🙏+|😭+|❤️+|❤+|🫡+|👏+|🥹+|🫶+|\+1)$/i;
const AGREE_PHRASE = /\b(so real|real talk|needed (to hear )?this|so true|this is (so )?true|w take|on god|wise words|life advice|core memory|thank you joe|that's deep|that hit|hit different|literally me|so fr)\b/i;
// talk mode: how many people must agree in 20 seconds, and how many times more than normal
const TALK = { chill: { mult: 3.0, min: 10 }, normal: { mult: 2.2, min: 7 }, hyped: { mult: 1.7, min: 5 } };

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

const defaultCfg = () => ({ clientId: '', enabled: true, streamers: [], sensitivity: 'normal', clipLen: 30, maxPerStream: 5, cooldown: 120, discord: '', alerts: true, digestOn: false, digestHour: 8, tz: 'America/Denver', ytKey: '', postsHook: '', queueOn: false, queueHour: 13, queueCount: 8, reactDelay: 8, ytChannel: '' });
// YouTube rules the daily queue checks against (games/labels from Twitch)
const SKIP_GAMES = { 'slots': 'gambling', 'virtual casino': 'gambling', 'casino': 'gambling', 'music': 'copyrighted music', 'djs': 'copyrighted music' };
const SKIP_LABELS = { Gambling: 'gambling', SexualThemes: 'sexual themes' };
const WARN_LABELS = { ViolentGraphic: 'graphic violence, so it may get age-restricted', DrugsIntoxication: 'drugs or drinking, so it may get age-restricted or limited ads', ProfanityVulgarity: 'heavy swearing, so it may get limited ads' };
const GUARD_BAD = ['S3', 'S4', 'S5', 'S10', 'S11', 'S12']; // sex crimes, child safety, defamation, hate, self-harm, sexual
const BAD_WORDS = /\b(stake\.com|stake\s*code|roobet|rollbit|gamdom|csgoempire|bet365|draftkings|fanduel|onlyfans|promo\s*code|use\s*code)\b/i;
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

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
    this.agreers = Array.from({ length: WINDOW }, () => null);
    this.baseA = null; this.baseU20 = null; this.lastA20 = 0;
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
      const i = s % WINDOW; this.n[i] = 0; this.h[i] = 0; this.c[i] = 0; this.tokens[i] = null; this.people[i] = null; this.hypers[i] = null; this.askers[i] = null; this.agreers[i] = null;
    }
    if (now > this.sec) this.sec = now;
  }
  add(now, who, hypeTokens, isClip, agreeTokens = []) {
    this.roll(now);
    const i = now % WINDOW;
    this.n[i]++;
    (this.people[i] || (this.people[i] = new Set())).add(who);
    if (agreeTokens.length) {
      (this.agreers[i] || (this.agreers[i] = new Set())).add(who);
      const m = this.tokens[i] || (this.tokens[i] = new Map());
      for (const t of agreeTokens) m.set(t, (m.get(t) || 0) + 1);
    }
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

function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function pctRank(vals) { const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), out = new Array(vals.length); idx.forEach(([, i], r) => { out[i] = vals.length > 1 ? r / (vals.length - 1) : 1; }); return out; }
function numFmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n)); }
// Rank raw Twitch clips. Only clips passing `pick` can be chosen; all clips count toward each streamer's normal.
export function bestMoments(raw, now, pick = () => true, limit = 8) {
  const rate = (c) => c.view_count / Math.max(0.25, (now - Date.parse(c.created_at)) / 3600000);
  const byStreamer = {};
  for (const c of raw) (byStreamer[c.broadcaster_id] = byStreamer[c.broadcaster_id] || []).push(rate(c));
  const moments = [];
  for (const c of raw.filter(pick).sort((a, b) => b.view_count - a.view_count)) {
    const t = Date.parse(c.created_at);
    const m = moments.find((x) => x.bid === c.broadcaster_id && (c.video_id && x.video === c.video_id && c.vod_offset != null && x.vodOffset != null ? Math.abs(x.vodOffset - c.vod_offset) <= 40 : Math.abs(x.t - t) <= 90000));
    if (m) { m.count++; m.views += c.view_count; m.people.add(c.creator_id); m.featured = m.featured || c.is_featured; }
    else moments.push({ best: c, count: 1, bid: c.broadcaster_id, video: c.video_id, vodOffset: c.vod_offset, t, views: c.view_count, people: new Set([c.creator_id]), featured: !!c.is_featured });
  }
  if (!moments.length) return [];
  for (const m of moments) {
    m.hours = Math.max(0.25, (now - m.t) / 3600000); m.perHour = m.views / m.hours;
    const list = byStreamer[m.bid] || [], med = median(list);
    m.standout = list.length >= 3 && med > 0 ? m.perHour / med : 1;
  }
  const P = pctRank(moments.map((m) => Math.log1p(m.views))), V = pctRank(moments.map((m) => Math.log1p(m.perHour))), O = pctRank(moments.map((m) => Math.log(m.standout + 0.01)));
  moments.forEach((m, i) => {
    const dur = m.best.duration, crowd = m.people.size >= 3 ? 1 : m.people.size === 2 ? 0.6 : 0;
    const lenFit = dur >= 12 && dur <= 45 ? 1 : dur < 8 ? 0.3 : 0.6, fresh = m.hours <= 24 ? 1 : m.hours <= 72 ? 0.6 : 0.3;
    m.score = Math.min(99, Math.round(100 * (0.32 * V[i] + 0.12 * P[i] + 0.28 * O[i] + 0.14 * crowd + 0.08 * lenFit + 0.06 * fresh) + (m.featured ? 3 : 0)));
    const why = [];
    if (m.standout >= 2) why.push([m.standout, `${m.standout >= 10 ? Math.round(m.standout) : m.standout.toFixed(1)}× faster than ${m.best.broadcaster_name}'s usual clip`]);
    if (m.people.size >= 2) why.push([5 + m.people.size, `${m.people.size} people clipped this moment`]);
    if (V[i] >= 0.75) why.push([4, `${numFmt(m.perHour)} views/hour`]);
    if (P[i] >= 0.8) why.push([3, `${numFmt(m.views)} views`]);
    m.why = why.sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]);
  });
  const out = [], per = {};
  for (const m of moments.sort((a, b) => b.score - a.score)) { if ((per[m.bid] = (per[m.bid] || 0) + 1) > 3) continue; out.push(m); if (out.length >= limit) break; }
  return out;
}

export class Watcher {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.st = ctx.storage;
    this.ws = null; this.session = null; this.subs = new Map(); this.stats = new Map();
    this.tickTimer = null; this.lastWsAt = 0; this.keepaliveSec = 10;
    this.refreshing = null; this.connecting = null; this.welcomeWait = null; this.device = null; this.trendCache = new Map(); this.gameCache = new Map(); this.ytCache = new Map();
    this.ready = this.load();
  }

  async load() {
    this.cfg = { ...defaultCfg(), ...((await this.st.get('cfg')) || {}) };
    this.auth = (await this.st.get('auth')) || null;
    this.clips = (await this.st.get('clips')) || [];
    this.log = (await this.st.get('log')) || [];
    this.live = (await this.st.get('live')) || {};
    this.key = (await this.st.get('key')) || null;
    this.lastDigest = (await this.st.get('lastDigest')) || '';
    this.ytUsage = (await this.st.get('ytUsage')) || { day: '', units: 0 };
    this.lastQueue = (await this.st.get('lastQueue')) || '';
    this.queue = (await this.st.get('queue')) || null;
    this.results = (await this.st.get('results')) || null;
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
    const given = req.headers.get('x-clipkit-key') || '';
    if (path === '/api/ai/transcribe' && method === 'POST') {
      if (!this.key || given !== this.key) return json({ error: 'Wrong or missing access key.' }, 401);
      try { return json(await this.aiTranscribe(await req.arrayBuffer(), url.searchParams.get('lang'), url.searchParams.get('engine'), req.headers.get('content-type'))); }
      catch (e) { return json({ error: e.message || String(e) }, 500); }
    }
    const body = method === 'POST' ? await req.json().catch(() => ({})) : {};
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
      if (path === '/api/streamers/campaign' && method === 'POST') {
        const s = this.cfg.streamers.find((x) => x.id === body.id);
        if (!s) return json({ error: 'Unknown streamer' }, 400);
        const c = body.campaign;
        if (!c || !String(c.name || '').trim()) { delete s.campaign; await this.st.put('cfg', this.cfg); this.addLog(`${s.name} is no longer a campaign streamer.`); return json({ ok: true }); }
        const tags = String(c.tags || '').split(/[\s,]+/).map((t) => t.replace(/^#*/, '').replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean).slice(0, 10).map((t) => '#' + t);
        s.campaign = { name: String(c.name).trim().slice(0, 60), credit: String(c.credit || '').trim().slice(0, 200), tags, rules: String(c.rules || '').trim().slice(0, 400) };
        await this.st.put('cfg', this.cfg); this.addLog(`${s.name} added to campaign "${s.campaign.name}".`);
        return json({ ok: true });
      }
      if (path === '/api/results' && method === 'POST') return json(await this.learnResults(true));
      if (path === '/api/streamers/style' && method === 'POST') {
        const s = this.cfg.streamers.find((x) => x.id === body.id);
        if (!s || !['hype', 'talk'].includes(body.style)) return json({ error: 'Unknown streamer or style' }, 400);
        s.style = body.style; await this.st.put('cfg', this.cfg);
        this.addLog(`${s.name} set to ${body.style === 'talk' ? 'Talk' : 'Hype'} style.`);
        return json({ ok: true });
      }
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
        if (typeof body.discord === 'string') {
          const w = body.discord.trim();
          if (w && !WEBHOOK_RE.test(w)) return json({ error: "That isn't a Discord webhook link. It should start with https://discord.com/api/webhooks/" }, 400);
          c.discord = w;
        }
        if (typeof body.alerts === 'boolean') c.alerts = body.alerts;
        if (typeof body.postsHook === 'string') {
          const w = body.postsHook.trim();
          if (w && !WEBHOOK_RE.test(w)) return json({ error: "That isn't a Discord webhook link. It should start with https://discord.com/api/webhooks/" }, 400);
          c.postsHook = w;
        }
        if (typeof body.queueOn === 'boolean') c.queueOn = body.queueOn;
        if (Number.isInteger(+body.queueHour) && body.queueHour !== undefined && body.queueHour !== null && +body.queueHour >= 0 && +body.queueHour <= 23) c.queueHour = +body.queueHour;
        if ([3, 5, 8].includes(+body.queueCount)) c.queueCount = +body.queueCount;
        if ([0, 4, 8, 12].includes(+body.reactDelay) && body.reactDelay !== undefined && body.reactDelay !== null) c.reactDelay = +body.reactDelay;
        if (typeof body.ytChannel === 'string') { const v = body.ytChannel.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/.*$/, ''); if (!v || /^(@[\w.-]{3,30}|UC[\w-]{22})$/.test(v)) { if (c.ytChannel !== v) this.results = null; c.ytChannel = v; } else return json({ error: 'Use your channel handle like @yourname' }, 400); }
        if (typeof body.digestOn === 'boolean') c.digestOn = body.digestOn;
        if (Number.isInteger(+body.digestHour) && +body.digestHour >= 0 && +body.digestHour <= 23 && body.digestHour !== undefined) c.digestHour = +body.digestHour;
        if (typeof body.tz === 'string' && body.tz) { try { new Intl.DateTimeFormat('en', { timeZone: body.tz }); c.tz = body.tz; } catch (e) {} }
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
      if (path === '/api/ai/moments' && method === 'POST') return json(await this.aiMoments(body));
      if (path === '/api/ai/postcopy' && method === 'POST') { try { return json(await this.postCopy(body)); } catch (e) { return json({ error: e.message }, 400); } }
      if (path === '/api/streamers/names') return json({ streamers: this.cfg.streamers.map((x) => ({ login: x.login, name: x.name, campaign: x.campaign ? x.campaign.name : null })) });
      if (path === '/api/youtube/key' && method === 'POST') {
        const k = String(body.key || '').trim();
        if (!k) { this.cfg.ytKey = ''; await this.st.put('cfg', this.cfg); return json({ ok: true }); }
        if (!/^[\w-]{30,60}$/.test(k)) return json({ error: "That doesn't look like a Google API key. It usually starts with AIza." }, 400);
        const t = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(k)}`);
        if (!t.ok) { const j = await t.json().catch(() => ({})); return json({ error: 'Google refused that key: ' + ((j.error && j.error.message) || t.status) + '. Make sure YouTube Data API v3 is enabled for it.' }, 400); }
        this.cfg.ytKey = k; await this.st.put('cfg', this.cfg); this.addYtUnits(1);
        return json({ ok: true });
      }
      if (path === '/api/youtube') return json(await this.youtube(url.searchParams));
      if (path === '/api/streamers/check-editor' && method === 'POST') {
        const s = this.cfg.streamers.find((x) => x.id === body.id); if (!s) return json({ error: 'Unknown streamer' }, 400);
        return json({ editor: await this.checkEditor(s) });
      }
      if (path === '/api/vodclip' && method === 'POST') return json(await this.vodClip(body));
      if (path === '/api/clips/ready') {
        const ed = new Set(this.cfg.streamers.filter((s) => s.editor === true).map((s) => s.id));
        return json({ clips: this.clips.filter((c) => c.status === 'ready' && ed.has(c.broadcaster_id)).slice(0, 50)
          .map((c) => ({ id: c.id, name: c.name, title: c.title || '', why: c.why, at: c.at, duration: c.duration, thumb: c.thumb })) });
      }
      if (path === '/api/clips/file') return await this.clipFile(url.searchParams.get('id'));
      if (path === '/api/discord/test' && method === 'POST') {
        if (!this.cfg.discord) return json({ error: 'Add a Discord webhook link first.' }, 400);
        await this.discord({ content: '✅ ClipKit Auto is connected. New clips and your morning picks will show up here.' });
        return json({ ok: true });
      }
      if (path === '/api/discord/post' && method === 'POST') {
        // used by the scheduled X / Reddit checks to send their report
        if (!this.cfg.discord) return json({ error: 'Add a Discord webhook link first.' }, 400);
        const content = String(body.content || '').slice(0, 2000);
        const embeds = (Array.isArray(body.embeds) ? body.embeds : []).slice(0, 10).map((e) => ({
          title: String(e.title || '').slice(0, 250) || undefined, url: /^https:\/\//.test(e.url || '') ? e.url : undefined,
          description: String(e.description || '').slice(0, 1500) || undefined, color: 0x4fd8ff }));
        if (!content && !embeds.length) return json({ error: 'Nothing to send.' }, 400);
        await this.discord({ username: 'ClipKit Scout', content: content || undefined, embeds });
        this.addLog('Sent a scout report to Discord.');
        return json({ ok: true });
      }
      if (path === '/api/queue/now' && method === 'POST') {
        if (!this.cfg.postsHook) return json({ error: 'Add the Discord webhook for your posts channel first.' }, 400);
        return json(await this.makeQueue(body.preview === true));
      }
      if (path === '/api/queue') return json({ queue: this.queue });
      if (path === '/api/posts/test' && method === 'POST') {
        if (!this.cfg.postsHook) return json({ error: 'Add the Discord webhook for your posts channel first.' }, 400);
        await this.discord({ username: 'ClipKit Queue', content: '✅ Your daily video queue will show up in this channel.' }, this.cfg.postsHook);
        return json({ ok: true });
      }
      if (path === '/api/digest/now' && method === 'POST') {
        if (!this.cfg.discord) return json({ error: 'Add a Discord webhook link first.' }, 400);
        return json(await this.sendDigest(true));
      }
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
      cfg: { enabled: this.cfg.enabled, sensitivity: this.cfg.sensitivity, clipLen: this.cfg.clipLen, maxPerStream: this.cfg.maxPerStream, cooldown: this.cfg.cooldown,
        discord: this.cfg.discord ? '…' + this.cfg.discord.slice(-6) : '', yt: !!this.cfg.ytKey,
        postsHook: this.cfg.postsHook ? '…' + this.cfg.postsHook.slice(-6) : '', queueOn: this.cfg.queueOn, queueHour: this.cfg.queueHour, queueCount: this.cfg.queueCount, queueAt: this.queue && this.queue.at, reactDelay: this.cfg.reactDelay, ytChannel: this.cfg.ytChannel, alerts: this.cfg.alerts, digestOn: this.cfg.digestOn, digestHour: this.cfg.digestHour, tz: this.cfg.tz },
      chat: !!(this.ws && this.session),
      streamers: this.cfg.streamers.map((s) => {
        const L = this.live[s.id], st = this.stats.get(s.id);
        const rate = st ? st.lastU5 : 0;
        return { ...s, style: s.style || 'hype', agree: st ? st.lastA20 : 0, live: !!L, title: L && L.title, game: L && L.game, viewers: L && L.viewers, since: L && L.since,
          rate: Math.round(rate * 10) / 10, base: st && st.base != null ? Math.round(st.base * 10) / 10 : null,
          clips: L ? this.clips.filter((c) => c.broadcaster_id === s.id && c.streamKey === L.since).length : 0 };
      }),
      clips: this.clips.slice(0, 80),
      results: this.results || null,
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
    this.checkEditor(s).catch(() => {});
    return { ok: true, streamer: s };
  }

  /* ---------------- the watch loop ---------------- */
  async alarm() {
    await this.ready;
    let anyLive = false;
    try { anyLive = await this.cycle(); }
    catch (e) { this.addLog('Problem: ' + e.message); }
    try { await this.maybeDigest(); }
    catch (e) { this.addLog('Morning picks failed: ' + e.message); }
    try { await this.maybeQueue(); }
    catch (e) { this.addLog('Daily queue failed: ' + e.message); }
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
    const stale = this.cfg.streamers.find((s) => s.editor !== true && this.now() - (s.editorChecked || 0) > 24 * 3600 * 1000);
    if (stale) await this.checkEditor(stale).catch(() => {});
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
    const agree = [];
    // Plain words like "real", "this" or "deep" only count when the whole message is a reaction ("real", "so real 🙏").
    // Strong ones ("facts", "frfr", 🙏, 💯) count in any short message.
    const clean = words.map((w) => w.replace(/[!?.,]+$/, '')).filter(Boolean);
    const allAgree = clean.length && clean.length <= 4 && clean.every((t) => AGREE_TOK.test(t) || /^(so|that|is|its|it's|bro|joe|thats|that's)$/i.test(t));
    for (const t of clean) {
      if (!AGREE_TOK.test(t) || HYPE_RE.test(t) || /^(so|that|is|its|it's|bro|joe|thats|that's)$/i.test(t)) continue;
      if (allAgree || (clean.length <= 5 && STRONG_AGREE.test(t))) agree.push(t.toLowerCase());
    }
    const ph = text.match(AGREE_PHRASE); if (ph) agree.push(ph[0].toLowerCase());
    st.add(Math.floor(this.now() / 1000), ev.chatter_user_id || login || Math.random(), hype, CLIP_RE.test(text), agree);
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
      const talk = this.styleOf(id) === 'talk';
      const a20 = talk ? st.union(st.agreers, nowS - 1, 20) : 0, u20 = talk ? st.union(st.people, nowS - 1, 20) : 0;
      st.lastA20 = a20;
      st.seen++;
      if (st.seen <= 60) {
        st.warmSum += u5; st.base = st.warmSum / st.seen;
        st.warmA = (st.warmA || 0) + a20; st.baseA = st.warmA / st.seen;
        continue; // learn normal first
      }
      const quiet = this.now() < st.quietUntil;
      const spiking = u5 > st.base * 1.5;
      st.base += (u5 - st.base) * (quiet ? 1 / 20 : spiking ? 1 / 900 : 1 / 120);
      if (talk) { const up = a20 > (st.baseA || 0) * 1.5; st.baseA += (a20 - st.baseA) * (quiet ? 1 / 20 : up ? 1 / 900 : 1 / 180); }
      if (quiet) continue; // raid, gifted subs, etc.
      if (talk) {
        const T = TALK[this.cfg.sensitivity] || TALK.normal;
        if (a20 >= T.min && a20 >= Math.max(st.baseA, 1) * T.mult && a20 / Math.max(u20, 1) >= 0.2) {
          const top = st.top(nowS - 1, 20).filter(([t]) => AGREE_TOK.test(t) || AGREE_PHRASE.test(t));
          this.tryClip(id, `${a20} people saying ${top.length ? top.slice(0, 2).map(([t]) => `“${t}”`).join(' and ') : 'it’s real'}`, top, 60);
          continue;
        }
      }
      const base = Math.max(st.base, 1);
      const fast = u5 >= S.min5 && u5 >= base * S.mult;
      const hypeShare = u5 ? hp5 / u5 : 0;
      const asked = ask10 >= 3 && u5 >= S.min5 / 2;
      if (!((fast && (hypeShare >= 0.25 || u5 >= base * S.mult * 1.6)) || asked)) continue;
      const why = asked && !fast ? `${ask10} people asked for a clip` : `${u5} people reacting at once (${(u5 / base).toFixed(1)}× normal)`;
      // wait a few seconds so the reaction is in the clip too, and make it that much longer
      const d = Math.max(0, Math.min(15, +this.cfg.reactDelay || 0));
      this.tryClip(id, why, st.top(nowS - 1, 10), d ? Math.min(60, this.cfg.clipLen + d) : 0, d * 1000);
    }
  }
  styleOf(id) { const s = this.cfg.streamers.find((x) => x.id === id); return (s && s.style) || 'hype'; }
  canClip(id) {
    const L = this.live[id], st = this.statsFor(id);
    if (!L || !this.cfg.enabled) return false;
    if (this.now() - st.lastClip < this.cfg.cooldown * 1000) return false;
    return this.clips.filter((c) => c.broadcaster_id === id && c.streamKey === L.since).length < this.cfg.maxPerStream;
  }
  tryClip(id, why, top, duration, delayMs) {
    if (!this.canClip(id)) return;
    this.statsFor(id).lastClip = this.now();
    const s = this.cfg.streamers.find((x) => x.id === id);
    if (s && s.style === 'talk') { duration = 60; delayMs = 0; }
    if (!s) return;
    const go = () => this.createClip(s, why, top, false, duration).catch((e) => this.addLog(`Clip failed for ${s.name}: ${e.message}`));
    if (delayMs > 0) setTimeout(() => { if (this.live[id] && this.cfg.enabled) go(); }, delayMs); else go();
  }
  // When several different viewers clip within the last minute, something good just happened
  async checkViewerClips(ids) {
    const since = new Date(this.now() - 90 * 1000).toISOString();
    await Promise.all(ids.map(async (id) => {
      if (!this.canClip(id)) return;
      let j; try { j = await this.helix('/clips', { query: { broadcaster_id: id, started_at: since, first: '20' } }); } catch (e) { return; }
      const fresh = (j.data || []).filter((c) => c.creator_id !== this.auth.userId && this.now() - Date.parse(c.created_at) < 75 * 1000);
      const people = new Set(fresh.map((c) => c.creator_id));
      if (people.size < 2) return;
      // already clipped this moment ourselves? then don't make a second one
      const t = fresh.map((c) => Date.parse(c.created_at)).sort((a, b) => a - b)[Math.floor(fresh.length / 2)];
      if (this.clips.some((c) => c.broadcaster_id === id && Math.abs(c.at - t) < 100 * 1000)) return;
      this.tryClip(id, `${people.size} viewers clipped this moment`, [], 60);
    }));
  }

  // twitch.tv VOD link that starts at a moment (seconds into the stream)
  vodLink(video, off) {
    if (!video || off == null) return '';
    const t = Math.max(0, Math.floor(off));
    return `https://www.twitch.tv/videos/${video}?t=${Math.floor(t / 3600)}h${Math.floor(t % 3600 / 60)}m${t % 60}s`;
  }
  // New clips often have no VOD spot yet; guess it from when the clip and the stream's VOD started
  async fillVodGuess(raw) {
    const need = raw.filter((c) => c.video_id && c.vod_offset == null);
    if (!need.length) return raw;
    this.vodStart = this.vodStart || new Map();
    const ids = [...new Set(need.map((c) => c.video_id))].filter((id) => !this.vodStart.has(id));
    for (let i = 0; i < ids.length; i += 100) {
      try { for (const v of (await this.helix('/videos', { query: { id: ids.slice(i, i + 100) } })).data || []) this.vodStart.set(v.id, Date.parse(v.created_at)); } catch (e) {}
    }
    for (const c of need) { const t0 = this.vodStart.get(c.video_id); if (t0) c.vod_offset = Math.max(0, (Date.parse(c.created_at) - t0) / 1000 - (c.duration || 30)); }
    return raw;
  }
  async createClip(s, why, top, manual, duration) {
    const L = this.live[s.id] || {};
    const title = (top && top.length ? `${top[0][0]} moment` : 'Hype moment').slice(0, 100);
    const j = await this.helix('/clips', { method: 'POST', query: { broadcaster_id: s.id, duration: String(Math.max(duration || 0, this.cfg.clipLen)), title } });
    const d = j.data && j.data[0];
    if (!d) throw new Error('Twitch did not return a clip.');
    const rec = { id: d.id, title, edit_url: d.edit_url, url: `https://clips.twitch.tv/${d.id}`, broadcaster_id: s.id, login: s.login, name: s.name,
      at: this.now(), why, top: (top || []).map(([t, n]) => `${t} ×${n}`), game: L.game || '', streamTitle: L.title || '', streamKey: L.since || '', status: 'processing', manual: !!manual };
    // where it is in the stream's VOD, so anyone can clip the same moment themselves (exact spot filled in later)
    try {
      const v = ((await this.helix('/videos', { query: { user_id: s.id, type: 'archive', first: '1' } })).data || [])[0];
      const len = Math.max(duration || 0, this.cfg.clipLen);
      if (v && (!L.since || Math.abs(Date.parse(v.created_at) - Date.parse(L.since)) < 15 * 60 * 1000)) { rec.video = v.id; rec.vodOffset = Math.max(0, (rec.at - Date.parse(v.created_at)) / 1000 - len); rec.vodEst = true; }
    } catch (e) {}
    if (L.since) rec.streamAt = Math.max(0, (rec.at - Date.parse(L.since)) / 1000 - Math.max(duration || 0, this.cfg.clipLen));
    this.clips.unshift(rec); if (this.clips.length > 200) this.clips.length = 200;
    await this.st.put('clips', this.clips);
    this.addLog(`Clipped ${s.name}: ${why}.`);
    if (this.cfg.discord && this.cfg.alerts) this.alertClip(rec).catch((e) => this.addLog('Discord alert failed: ' + e.message));
    await this.kick(20000);
    return { ok: true, clip: rec };
  }
  async checkClips() {
    const pending = this.clips.filter((c) => c.status === 'processing');
    const now = this.now();
    const fix = this.clips.filter((c) => c.status === 'ready' && (c.vodEst || !c.video) && now - c.at < 48 * 3600 * 1000 && now - (c.vodTry || 0) > 5 * 60 * 1000).slice(0, 50);
    if (!pending.length && !fix.length) return;
    const ids = [...pending, ...fix].slice(0, 100).map((c) => c.id);
    const j = await this.helix('/clips', { query: { id: ids } });
    const exact = new Set((j.data || []).filter((c) => c.vod_offset != null).map((c) => c.id));
    await this.fillVodGuess(j.data || []);
    const found = new Map((j.data || []).map((c) => [c.id, c]));
    let changed = false;
    const takeVod = (c, f) => { if (f.video_id && f.vod_offset != null && (exact.has(f.id) || !c.video)) { c.video = f.video_id; c.vodOffset = f.vod_offset; c.vodEst = !exact.has(f.id); } };
    // clips made through the API usually come back with no VOD link, so find the stream's VOD ourselves
    const archiveGuess = async (c) => {
      if (c.video || !c.streamKey) return;
      this.archives = this.archives || new Map();
      let list = this.archives.get(c.broadcaster_id);
      if (!list || now - list.at > 10 * 60 * 1000) {
        try { list = { at: now, v: (await this.helix('/videos', { query: { user_id: c.broadcaster_id, type: 'archive', first: '10' } })).data || [] }; } catch (e) { list = { at: now, v: [] }; }
        this.archives.set(c.broadcaster_id, list);
      }
      const v = list.v.find((x) => Math.abs(Date.parse(x.created_at) - Date.parse(c.streamKey)) < 15 * 60 * 1000);
      if (v) { c.video = v.id; c.vodOffset = Math.max(0, (c.at - Date.parse(v.created_at)) / 1000 - (c.duration || this.cfg.clipLen)); c.vodEst = true; }
    };
    for (const c of fix) { c.vodTry = now; const f = found.get(c.id); if (f) takeVod(c, f); await archiveGuess(c); changed = true; }
    for (const c of pending) {
      const f = found.get(c.id);
      if (f) {
        c.status = 'ready'; c.thumb = f.thumbnail_url; c.duration = f.duration; c.url = f.url || c.url; takeVod(c, f); changed = true;
        if (this.cfg.discord && this.cfg.alerts) this.alertClip(c).catch((e) => this.addLog('Discord alert failed: ' + e.message));
      }
      else if (now - c.at > 90000) { c.status = 'failed'; changed = true; if (c.msgId) this.alertClip(c).catch(() => {}); }
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
        this.helix('/clips', { query: { broadcaster_id: s.id, started_at: started, ended_at: ended, first: '50' } }).then((j) => j.data || []).catch(() => [])));
      raw = lists.flat();
    }
    await this.fillVodGuess(raw);
    const mine = new Set(this.clips.map((c) => c.id));
    const clips = raw.map((c) => {
      const hours = Math.max(0.25, (this.now() - Date.parse(c.created_at)) / 3600000);
      return { id: c.id, url: c.url, title: c.title, name: c.broadcaster_name, bid: c.broadcaster_id, by: c.creator_name, byId: c.creator_id, featured: !!c.is_featured, lang: c.language, views: c.view_count, created: c.created_at,
        perHour: Math.round(c.view_count / hours), duration: c.duration, thumb: c.thumbnail_url, video: c.video_id || '', vodOffset: c.vod_offset == null ? null : c.vod_offset, mine: mine.has(c.id) };
    });
    const data = { clips, game: game && game.name, at: this.now() };
    this.trendCache.set(cacheKey, { at: this.now(), data });
    if (this.trendCache.size > 30) this.trendCache.delete(this.trendCache.keys().next().value);
    return data;
  }


  /* ---------------- Discord ---------------- */
  async discord(payload, hook) {
    const url = hook || this.cfg.discord;
    if (!url) return false;
    const r = await fetch(url + '?wait=true', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ClipKit Auto', allowed_mentions: { parse: [] }, ...payload }) });
    if (!r.ok) {
      if (r.status === 404 || r.status === 401) throw new Error('Discord says that webhook no longer exists. Paste a new one.');
      throw new Error(`Discord said ${r.status}.`);
    }
    const m = await r.json().catch(() => null);
    return (m && m.id) || true;
  }
  async discordEdit(id, payload, hook) {
    const url = hook || this.cfg.discord;
    if (!url || !id || id === true) return false;
    const r = await fetch(`${url}/messages/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }) });
    return r.ok;
  }
  // hh:mm:ss into the stream
  streamTime(sec) { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
  alertPayload(c) {
    const lines = [];
    if (c.streamAt != null) lines.push(`⏱️ **${this.streamTime(c.streamAt)}** into the stream`);
    if (c.top && c.top.length) lines.push('💬 Chat: ' + c.top.join(', '));
    if (c.game) lines.push('🎮 ' + c.game);
    const camp = (this.cfg.streamers.find((x) => x.id === c.broadcaster_id) || {}).campaign;
    if (camp) lines.push(`💰 Campaign: **${camp.name}**`);
    const vl = this.vodLink(c.video, c.vodOffset);
    if (vl) lines.push(`[✂️ Clip it yourself from the VOD](${vl})`);
    lines.push(c.status === 'ready' ? `[▶️ Watch the clip](${c.url})` : c.status === 'failed' ? '⚠️ Twitch couldn\'t make this clip. Use the VOD link instead.' : '⏳ Twitch is still making the clip…');
    return { embeds: [{ title: `${c.name}: ${c.why}`.slice(0, 250), url: c.status === 'ready' ? c.url : (vl || undefined), description: lines.join('\n'), color: c.status === 'failed' ? 0x888888 : 0xff4f5e,
      image: c.thumb ? { url: c.thumb } : undefined, footer: { text: c.manual ? 'You tapped Clip now' : 'Auto clipped' }, timestamp: new Date(c.at).toISOString() }] };
  }
  // sent the moment the clip is made, then updated when Twitch finishes it
  async alertClip(c) {
    if (c.msgId) { if (await this.discordEdit(c.msgId, this.alertPayload(c))) return; }
    const id = await this.discord(this.alertPayload(c));
    if (id && id !== true) { c.msgId = id; c.sentAt = this.now(); await this.st.put('clips', this.clips); }
  }
  localNow() {
    let p;
    try { p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(this.now())).map((x) => [x.type, x.value])); }
    catch (e) { const d = new Date(this.now()); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; }
    return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
  }
  async maybeDigest() {
    if (!this.cfg.digestOn || !this.cfg.discord || !this.auth || this.auth.broken || !this.cfg.streamers.length) return;
    const { day, hour } = this.localNow();
    if (this.lastDigest === day || hour < this.cfg.digestHour || hour > this.cfg.digestHour + 2) return;
    this.lastDigest = day; await this.st.put('lastDigest', day);
    await this.sendDigest(false);
  }
  async sendDigest(manual) {
    const since = this.now() - 14 * 3600 * 1000;
    const started = new Date(this.now() - 72 * 3600 * 1000).toISOString();
    const lists = await Promise.all(this.cfg.streamers.map((s) =>
      this.helix('/clips', { query: { broadcaster_id: s.id, started_at: started, first: '100' } }).then((j) => j.data || []).catch(() => [])));
    const raw = await this.fillVodGuess(lists.flat());
    const picks = bestMoments(raw, this.now(), (c) => Date.parse(c.created_at) >= since, 5);
    const mine = this.clips.filter((c) => c.at >= since && c.status === 'ready');
    const head = manual ? 'Best clips from the last 14 hours' : 'Good morning. Best clips from while you were away';
    if (!picks.length && !mine.length) {
      await this.discord({ content: `**${head}:** nothing stood out. Quiet night.` });
      return { ok: true, picks: 0 };
    }
    const embeds = picks.map((m) => {
      const c = m.best, off = c.vod_offset;
      const vod = c.video_id && off != null ? `\n[Clip it yourself from the VOD](https://www.twitch.tv/videos/${c.video_id}?t=${Math.floor(off / 3600)}h${Math.floor(off % 3600 / 60)}m${Math.floor(off % 60)}s)` : '';
      return { title: `${m.score} · ${c.title}`.slice(0, 250), url: c.url, color: 0xffd23f, description: `**${c.broadcaster_name}** · ${m.why.join(' · ') || numFmt(m.views) + ' views'}${vod}`, thumbnail: c.thumbnail_url ? { url: c.thumbnail_url } : undefined };
    });
    const mineLine = mine.length ? `\nYour auto clipper made **${mine.length}** clip${mine.length === 1 ? '' : 's'} overnight. Open the page to download ${mine.length === 1 ? 'it' : 'them'}.` : '';
    await this.discord({ content: `**${head}:**${mineLine}`, embeds });
    this.addLog(`Sent ${picks.length} morning pick${picks.length === 1 ? '' : 's'} to Discord.`);
    return { ok: true, picks: picks.length };
  }


  /* ---------------- Editor mode ---------------- */
  // You're an editor for a channel if Twitch lets you get download links for its clips.
  async checkEditor(s) {
    let j;
    try { j = await this.helix('/clips', { query: { broadcaster_id: s.id, first: '1' } }); } catch (e) { return s.editor; }
    const c = j.data && j.data[0];
    s.editorChecked = this.now();
    if (!c) { await this.st.put('cfg', this.cfg); return s.editor == null ? null : s.editor; }
    const was = s.editor;
    try { await this.helix('/clips/downloads', { query: { editor_id: this.auth.userId, broadcaster_id: s.id, clip_id: c.id } }); s.editor = true; }
    catch (e) { if (e.status === 403 || e.status === 401 || e.status === 400) s.editor = false; else return s.editor; }
    await this.st.put('cfg', this.cfg);
    if (s.editor && !was) this.addLog(`You're an editor for ${s.name}. Their clips now download automatically, and you can clip from their VODs.`);
    return s.editor;
  }
  async vodClip(b) {
    const s = this.cfg.streamers.find((x) => x.id === b.broadcaster_id);
    if (!s) throw new Error('Add this streamer to your list first.');
    if (s.editor !== true) { const e = new Error(`You need to be an editor for ${s.name} to clip from their VODs.`); e.status = 403; throw e; }
    if (!b.video_id || b.end == null) throw new Error('This clip has no VOD to clip from.');
    const duration = Math.min(60, Math.max(5, Math.round(+b.duration || 30)));
    const end = Math.max(duration, Math.round(+b.end));
    const title = String(b.title || 'Best moment').slice(0, 100);
    const j = await this.helix('/videos/clips', { method: 'POST', query: { editor_id: this.auth.userId, broadcaster_id: s.id, vod_id: String(b.video_id), vod_offset: String(end), duration: String(duration), title } });
    const d = j.data && j.data[0];
    if (!d) throw new Error('Twitch did not return a clip.');
    const rec = { id: d.id, title, edit_url: d.edit_url, url: `https://clips.twitch.tv/${d.id}`, broadcaster_id: s.id, login: s.login, name: s.name,
      at: this.now(), why: 'Clipped from the VOD', top: [], game: '', streamKey: 'vod', status: 'processing', manual: true };
    this.clips.unshift(rec); if (this.clips.length > 200) this.clips.length = 200;
    await this.st.put('clips', this.clips);
    this.addLog(`Clipped ${s.name} from the VOD: ${title}.`);
    await this.kick(20000);
    return { ok: true, clip: rec };
  }
  async clipFile(id) {
    const c = this.clips.find((x) => x.id === id);
    if (!c) return json({ error: 'Clip not found.' }, 404);
    const r = await this.download(id);
    if (!r.url) return json({ error: "Twitch won't give a download for this clip. You need to be an editor for that channel." }, 403);
    const v = await fetch(r.url);
    if (!v.ok || !v.body) return json({ error: `Twitch's video server said ${v.status}.` }, 502);
    const name = (c.title || c.name + ' clip').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'clip';
    const headers = { 'content-type': v.headers.get('content-type') || 'video/mp4', 'x-clip-name': name, 'cache-control': 'no-store' };
    if (v.headers.get('content-length')) headers['content-length'] = v.headers.get('content-length');
    return new Response(v.body, { headers });
  }


  /* ---------------- AI for ClipKit's Moments tab ---------------- */
  ai() { if (!this.env || !this.env.AI) throw new Error('Cloudflare AI is not turned on for this worker yet. Redeploy it from GitHub.'); return this.env.AI; }
  async aiTranscribe(buf, lang, engine, ctype) {
    if (!buf || buf.byteLength < 100) throw new Error('No audio was sent.');
    if (buf.byteLength > 25 * 1024 * 1024) throw new Error('Audio piece too big.');
    // Whisper large (with a casual-speech prompt) tested best on real stream audio; Nova-3 only when asked for
    if (engine === 'nova') return await this.novaTranscribe(buf, lang, ctype);
    const bytes = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const opts = { audio: btoa(bin), vad_filter: true, condition_on_previous_text: false, initial_prompt: "Umm, like, I'm gonna keep it real, bro. Nah, he's wildin'." };
    if (lang && /^[a-z]{2}$/.test(lang)) opts.language = lang;
    const r = await this.ai().run('@cf/openai/whisper-large-v3-turbo', opts);
    const segs = (r.segments || []).map((s) => ({ start: +s.start || 0, end: +s.end || 0, text: String(s.text || '').trim(),
      words: Array.isArray(s.words) ? s.words.map((w) => ({ w: String(w.word || '').trim(), s: +w.start || 0, e: +w.end || 0 })).filter((w) => w.w) : null })).filter((s) => s.text);
    return { segments: segs, text: r.text || '', engine: 'whisper' };
  }
  async novaTranscribe(buf, lang, ctype) {
    const opts = { audio: { body: new Response(buf).body, contentType: ctype || 'audio/wav' }, smart_format: true, punctuate: true, numerals: true };
    opts.language = lang && /^[a-z]{2}$/.test(lang) ? lang : 'en';
    const r = await this.ai().run('@cf/deepgram/nova-3', opts);
    const alt = r && r.results && r.results.channels && r.results.channels[0] && r.results.channels[0].alternatives && r.results.channels[0].alternatives[0];
    if (!alt || !Array.isArray(alt.words)) throw new Error('Nova gave no words: ' + JSON.stringify(r).slice(0, 200));
    const words = alt.words.map((w) => ({ w: String(w.punctuated_word || w.word || '').trim(), s: +w.start || 0, e: +w.end || 0 })).filter((w) => w.w);
    // sentence-sized segments (Moments uses these)
    const segs = []; let cur = null;
    for (const w of words) {
      if (!cur || w.s - cur.end > 1.2 || cur.words.length >= 40) { cur = { start: w.s, end: w.e, words: [] }; segs.push(cur); }
      cur.words.push(w); cur.end = w.e;
      if (/[.!?]$/.test(w.w) && cur.words.length >= 4) cur = null;
    }
    for (const sg of segs) sg.text = sg.words.map((w) => w.w).join(' ');
    return { segments: segs, text: alt.transcript || '', engine: 'nova' };
  }
  async aiMoments(b) {
    const lines = Array.isArray(b.lines) ? b.lines.slice(0, 900) : [];
    if (!lines.length) return { moments: [] };
    const LEN = { short: [15, 35], medium: [25, 60], long: [45, 90] }[b.len] || [25, 60];
    const KIND = { any: 'any kind that would do well', funny: 'funny moments and jokes', takes: 'bold opinions and hot takes', stories: 'complete stories', deep: 'deep, real or inspiring talk and advice' }[b.kind] || 'any kind that would do well';
    const count = Math.min(5, Math.max(1, +b.count || 3));
    const transcript = lines.map((l) => `[${Math.round(+l.t)}] ${String(l.text).slice(0, 400)}`).join('\n');
    const sys = 'You are an expert short-form video editor. You find the most clip-worthy moments in long talking videos (podcasts, streams, interviews) for TikTok, Reels and Shorts. A great moment works with zero context: a complete funny story, a bold opinion, a surprising fact, a relatable rant, a deep or emotional insight, a heated debate. It starts exactly where the idea starts (never mid-sentence, never with filler) and ends right after the punchline or conclusion. Skip intros, outros, sponsor reads, technical problems, small talk and anything that needs earlier context. Be picky: return fewer moments if few are strong. Titles are short, punchy hooks (max 9 words) that make people want to watch, true to what is said, no emojis, no ALL CAPS.';
    const user = `Find up to ${count} moments. Focus on: ${KIND}. Each moment must be ${LEN[0]} to ${LEN[1]} seconds long. Use the timestamps (seconds) from the transcript. Transcript lines are "[start seconds] text":\n\n${transcript}`;
    const schema = { type: 'object', properties: { moments: { type: 'array', items: { type: 'object', properties: {
      start: { type: 'number' }, end: { type: 'number' }, title: { type: 'string' }, type: { type: 'string', enum: ['funny', 'hot take', 'story', 'insight', 'emotional', 'debate', 'other'] },
      reason: { type: 'string' }, score: { type: 'integer' } }, required: ['start', 'end', 'title', 'reason', 'score'] } } }, required: ['moments'] };
    const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    let out;
    try {
      const r = await this.ai().run(model, { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], response_format: { type: 'json_schema', json_schema: schema }, max_tokens: 1200, temperature: 0.3 });
      out = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
    } catch (e) {
      const r = await this.ai().run(model, { messages: [{ role: 'system', content: sys + ' Reply with only JSON like {"moments":[{"start":12,"end":48,"title":"...","type":"story","reason":"...","score":8}]}.' }, { role: 'user', content: user }], max_tokens: 1200, temperature: 0.3 });
      const m = String(r.response || '').match(/\{[\s\S]*\}/);
      try { out = m ? JSON.parse(m[0]) : { moments: [] }; } catch (err) { out = { moments: [] }; }
    }
    const first = +lines[0].t, last = +lines[lines.length - 1].t + 30;
    const moments = (out && Array.isArray(out.moments) ? out.moments : []).map((m) => ({
      start: +m.start, end: +m.end, title: String(m.title || '').slice(0, 90), type: String(m.type || 'other'), reason: String(m.reason || '').slice(0, 200), score: Math.max(1, Math.min(10, Math.round(+m.score || 5)))
    })).filter((m) => isFinite(m.start) && isFinite(m.end) && m.end - m.start >= LEN[0] * 0.6 && m.end - m.start <= LEN[1] * 1.6 && m.start >= first - 5 && m.end <= last + 30 && m.title);
    return { moments };
  }


  /* ---------------- YouTube: what clippers are posting ---------------- */
  ytDay() { return this.localNow().day; }
  addYtUnits(n) {
    const d = this.ytDay();
    if (this.ytUsage.day !== d) this.ytUsage = { day: d, units: 0 };
    this.ytUsage.units += n; this.st.put('ytUsage', this.ytUsage);
  }
  async yt(path, params, units) {
    const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('key', this.cfg.ytKey);
    const r = await fetch(u.toString());
    this.addYtUnits(units);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
      if (reason === 'quotaExceeded') throw new Error("You've used today's free YouTube searches. They reset at midnight Pacific time.");
      throw new Error('YouTube said: ' + ((j.error && j.error.message) || r.status));
    }
    return j;
  }
  async youtube(q) {
    if (!this.cfg.ytKey) return { needKey: true };
    const days = ({ '1d': 1, '7d': 7, '30d': 30 })[q.get('range')] || 7;
    const scope = q.get('scope') === 'search' ? 'search' : 'streamers';
    const text = String(q.get('q') || '').trim().slice(0, 80);
    const queries = scope === 'search' ? (text ? [{ q: text, who: text }] : []) : this.cfg.streamers.slice(0, 10).map((s) => ({ q: s.name, who: s.name }));
    if (!queries.length) return { videos: [], note: scope === 'search' ? 'Type something to search for.' : 'Add streamers on the Auto clips tab first.' };
    const key = `${scope}|${days}|${queries.map((x) => x.q.toLowerCase()).join(',')}`;
    const hit = this.ytCache.get(key);
    if (hit && this.now() - hit.at < 6 * 3600 * 1000) return { ...hit.data, cached: true, usage: this.ytUsage };
    const after = new Date(this.now() - days * 86400000).toISOString();
    const found = new Map();
    for (const x of queries) {
      const j = await this.yt('search', { part: 'snippet', q: x.q, type: 'video', videoDuration: 'short', order: 'viewCount', publishedAfter: after, maxResults: '25', safeSearch: 'none' }, 100);
      for (const it of j.items || []) if (it.id && it.id.videoId && !found.has(it.id.videoId)) found.set(it.id.videoId, { id: it.id.videoId, about: x.who });
    }
    const ids = [...found.keys()], videos = [];
    for (let i = 0; i < ids.length; i += 50) {
      const j = await this.yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') }, 1);
      for (const v of j.items || []) {
        const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(v.contentDetails && v.contentDetails.duration || '') || [];
        const secs = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
        if (secs === 0 || secs > 180) continue; // Shorts are 3 minutes or less
        const st = v.statistics || {}, sn = v.snippet || {};
        const hours = Math.max(0.5, (this.now() - Date.parse(sn.publishedAt)) / 3600000);
        const views = +st.viewCount || 0;
        videos.push({ id: v.id, url: `https://www.youtube.com/shorts/${v.id}`, title: sn.title || '', channel: sn.channelTitle || '', channelId: sn.channelId || '', about: found.get(v.id).about,
          published: sn.publishedAt, secs, views, likes: +st.likeCount || 0, comments: +st.commentCount || 0, perHour: Math.round(views / hours),
          thumb: (sn.thumbnails && (sn.thumbnails.high || sn.thumbnails.medium || sn.thumbnails.default) || {}).url || '' });
      }
    }
    const data = { videos, at: this.now() };
    this.ytCache.set(key, { at: this.now(), data });
    if (this.ytCache.size > 20) this.ytCache.delete(this.ytCache.keys().next().value);
    return { ...data, usage: this.ytUsage };
  }


  /* ---------------- Daily video queue ---------------- */
  async maybeQueue() {
    if (!this.cfg.queueOn || !this.cfg.postsHook || !this.auth || this.auth.broken || !this.cfg.streamers.length) return;
    const { day, hour } = this.localNow();
    if (this.lastQueue === day || hour < this.cfg.queueHour || hour > this.cfg.queueHour + 2) return;
    this.lastQueue = day; await this.st.put('lastQueue', day);
    await this.makeQueue();
  }
  slotTimes(n) {
    // best first: Shorts tend to peak late afternoon / evening
    const order = [16, 18, 19, 17, 20, 15, 21, 14];
    return order.slice(0, n).map((h) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`);
  }
  async writeCopy(items) {
    if (!this.env || !this.env.AI) return null;
    const list = items.map((it, i) => `${i + 1}. Streamer: ${it.name}${it.game ? ' (in ' + it.game + ')' : ''}.${it.streamTitle ? ' Stream title: "' + it.streamTitle.slice(0, 140) + '".' : ''} Clip title: "${it.title}". Why it's good: ${it.why}.${it.chat ? ' Chat was spamming: ' + it.chat + '.' : ''}${it.scene ? ' One still frame from the clip shows: ' + it.scene + '.' : ''}`).join('\n');
    const sys = 'You write titles and descriptions for YouTube Shorts made from Twitch stream clips. They must follow YouTube\'s rules. Titles: under 70 characters, a curiosity hook that makes people want to watch, names the streamer, sounds like a person wrote it, no emojis, no ALL CAPS words except a streamer name. Use the concrete details you are given (what the frame shows, the stream title, what chat reacted with) to make the title specific, but NEVER invent details that are not in the information given; the still frame is one moment and may not show the key part, so describe the setting or situation, not an outcome you cannot see; and never promise something the clip may not show (no fake drama, no "gone wrong", no "banned", no "you won\'t believe"); if the info is thin, keep the title general and honest. Never insult, mock or sexualize anyone, never use slurs, and never name or hint at gambling or betting sites, promo codes or sponsors. Description: one or two short sentences, no links. Hashtags: 3 to 5, each directly about this clip (the streamer, the game, the kind of moment), always including #shorts; never trending tags that are unrelated. Angle: one short idea for the creator\'s OWN commentary to add on top (a caption or voiceover line that explains, reacts to or gives context to the moment), without inventing what happens.';
    const user = `Write copy for each clip. Give 3 different title options per clip.\n\n${list}`;
    const schema = { type: 'object', properties: { clips: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, titles: { type: 'array', items: { type: 'string' } }, description: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } }, angle: { type: 'string' } }, required: ['n', 'titles', 'description', 'hashtags', 'angle'] } } }, required: ['clips'] };
    try {
      const r = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], response_format: { type: 'json_schema', json_schema: schema }, max_tokens: 2000, temperature: 0.6 });
      const out = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
      return out && Array.isArray(out.clips) ? out.clips : null;
    } catch (e) { return null; }
  }
  // Writes ready-to-paste YouTube / TikTok / Instagram copy for a finished video (ClipKit's "Post it" button)
  async postCopy(b) {
    const raw = String(b.streamer || '').trim().replace(/^@/, '');
    if (!raw) throw new Error('Pick which streamer is in the video.');
    const st = this.cfg.streamers.find((x) => (x.login || '').toLowerCase() === raw.toLowerCase() || (x.name || '').toLowerCase() === raw.toLowerCase());
    const name = st ? st.name : raw.slice(0, 40), login = st ? st.login : (/^\w{3,25}$/.test(raw) ? raw.toLowerCase() : '');
    const camp = st && st.campaign ? st.campaign : null;
    const said = String(b.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 2500), hook = String(b.hook || '').trim().slice(0, 120), note = String(b.note || '').trim().slice(0, 300);
    if (!said && !hook && !note) throw new Error('Add captions, a title or a short note about what happens first.');
    if (!this.env || !this.env.AI) throw new Error('AI is not set up on the auto clipper.');
    const sys = `You write posting copy for short vertical clips of Twitch streamers (YouTube Shorts, TikTok, Instagram Reels). Sound like a real clipper who finds the clip funny: casual, punchy, specific, at most one emoji per line.
How to write it:
- Find the PUNCHLINE: the funniest, most surprising or most quotable line in the transcript (often near the end) and build every hook around it. Be specific to this clip, never generic ("Lacy Loses It", "Streamer Gets Mad" are bad).
- Keep it playful and on the streamer's side. Bits, jokes and trolling are framed as jokes. Never make the streamer look bad: no "L", "exposed", "fail", "loses it", "goes off", "heated", "toxic", mocking, or fake drama.
- Every title and caption names the streamer. Never quote swear words (pick a clean line). Never invent events, quotes or outcomes that are not in the transcript, title or note.
- No slurs, nothing sexual, no gambling sites, promo codes, sponsors or links.
Formats: YouTube titles: 3 different options, under 70 characters. ytLine: one or two sentences for the description. tiktok: one line under 120 characters. instagram: one line, can be a bit longer. tags: 6 to 10 lowercase YouTube search tags (streamer name variations, topic, kind of moment). hashtags: 2 to 3 about the clip's topic (like #chess, #thanksgiving, #funny); not the streamer's name, not #fyp/#viral, and not #gaming/#streamer unless the clip is about a game.
Example. Input: Streamer Lacy. Said: "when I say big bucks, big bucks for buddy... the big bucks. 25 cents an hour." Good output: titles ["Lacy Offers His Employee \\"The Big Bucks\\" 😭", "Lacy's Employee Is Getting Paid 25 Cents an Hour", "Lacy Promised Him the Big Bucks"], ytLine "Lacy promised the big bucks… 25 cents an hour 😭", tiktok "Lacy promised him the big bucks… 25 cents an hour 😭", instagram "Lacy said \\"big bucks\\" and meant 25 cents an hour 😭", hashtags ["#funny", "#boss"].
Example. Input: Streamer Jynxzi. Said: "bro we have this coming... start firing on... this is here... I just got checkmated." Good output: titles ["Jynxzi Was SO Sure He Had This Chess Game", "Jynxzi Gets Checkmated Out of Nowhere 😭", "\\"I Just Got Checkmated\\" – Jynxzi"], tiktok "Jynxzi was SO sure he had this 😭", hashtags ["#chess", "#checkmate"].` + (camp && camp.rules ? ` This streamer has a paid campaign; follow its rules exactly: ${camp.rules}` : '');
    const user = `Streamer: ${name}${login ? ' (twitch.tv/' + login + ')' : ''}\n${hook ? 'On-screen title: ' + hook + '\n' : ''}${note ? 'Note from the clipper: ' + note + '\n' : ''}${said ? 'What is said in the clip (auto captions, may have small errors): ' + said : ''}`;
    const schema = { type: 'object', properties: { titles: { type: 'array', items: { type: 'string' } }, ytLine: { type: 'string' }, tiktok: { type: 'string' }, instagram: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, hashtags: { type: 'array', items: { type: 'string' } } }, required: ['titles', 'ytLine', 'tiktok', 'instagram', 'tags', 'hashtags'] };
    let out = null;
    for (let i = 0; i < 2 && !out; i++) {
      try {
        const r = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], response_format: { type: 'json_schema', json_schema: schema }, max_tokens: 900, temperature: 0.8 });
        const o = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
        if (o && Array.isArray(o.titles) && o.titles.length) out = o;
      } catch (e) {}
    }
    if (!out) throw new Error('The AI is busy. Try again in a minute.');
    const clean = (t) => String(t || '').replace(BAD_WORDS, '').replace(/https?:\/\/\S+/g, '').replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
    const tag = (t) => '#' + String(t).replace(/[^\p{L}\p{N}_]/gu, '');
    const nameTag = camp && camp.tags.length ? null : tag(name.replace(/\s+/g, ''));
    const extra = (out.hashtags || []).map(tag).filter((t) => t.length > 2 && !/^#(fyp|foryou|foryoupage|viral|trending|explore|shorts)$/i.test(t) && !BAD_WORDS.test(t));
    const uniq = (a) => { const seen = new Set(); return a.filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())); };
    const req = camp ? camp.tags : [];
    const credit = camp && camp.credit ? camp.credit : `Clip from ${name}'s stream${login ? `: twitch.tv/${login}` : ''}. All credit to ${name}.`;
    const yt = uniq(['#shorts', ...req, nameTag, ...extra]).slice(0, Math.max(5, req.length + 1));
    const social = uniq([...req, nameTag, ...extra, '#twitchclips']).slice(0, Math.max(4, req.length));
    const res = {
      streamer: name, campaign: camp ? { name: camp.name, rules: camp.rules } : null,
      youtube: { titles: [...new Set(out.titles.map(clean).filter((t) => t.length > 5).map((t) => t.slice(0, 100)))].slice(0, 3), description: `${clean(out.ytLine)}\n${credit}\n${yt.join(' ')}`, tags: uniq((out.tags || []).map((t) => String(t).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()).filter(Boolean)).slice(0, 10).join(', ') },
      tiktok: `${clean(out.tiktok)} ${social.join(' ')}`.trim(),
      instagram: `${clean(out.instagram)}\n\n🎥 ${credit}\n${social.join(' ')}`,
    };
    // safety check on everything it wrote
    const ok = await this.guard([...res.youtube.titles, res.youtube.description, res.tiktok, res.instagram].join('\n'));
    if (ok === false) throw new Error("The AI wrote something that could break platform rules, so it was thrown out. Try again or add a note about what happens.");
    return res;
  }
  // Looks at the clip's thumbnail frame and says what's in it (no names)
  async describeFrame(url) {
    if (!this.env || !this.env.AI || !/^https:\/\//.test(url || '')) return '';
    try {
      const img = await fetch(url);
      if (!img.ok) { this.frameErr = 'thumbnail ' + img.status; return ''; }
      const bytes = new Uint8Array(await img.arrayBuffer()); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const dataUri = `data:${img.headers.get('content-type') || 'image/jpeg'};base64,${btoa(bin)}`;
      const r = await Promise.race([
        this.env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', { max_tokens: 80, temperature: 0.2, messages: [{ role: 'user', content: [
          { type: 'text', text: 'This is a frame from a livestream. In one short sentence, say what is happening: the setting, what the person is doing or wearing, and what game or scene is on screen. Do not guess anyone\'s name. Do not mention the stream overlay, chat box or webcam border.' },
          { type: 'image_url', image_url: { url: dataUri } }] }] }),
        new Promise((_, no) => setTimeout(() => no(new Error('slow')), 20000))]);
      const t = typeof r === 'string' ? r : r && (r.response || r.answer || r.result || r.text);
      if (!t) this.frameErr = 'no text: ' + JSON.stringify(r).slice(0, 300);
      return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    } catch (e) { this.frameErr = String(e && e.message || e).slice(0, 300); return ''; }
  }
  // Llama Guard: true = looks fine, false = break a YouTube rule, null = couldn't check
  async guard(text) {
    if (!this.env || !this.env.AI || !text) return null;
    try {
      const r = await this.env.AI.run('@cf/meta/llama-guard-3-8b', { messages: [{ role: 'user', content: String(text).slice(0, 1500) }] });
      const out = r && r.response !== undefined ? r.response : r;
      if (out && typeof out === 'object') return out.safe !== false || !(out.categories || []).some((c) => GUARD_BAD.includes(String(c).toUpperCase()));
      const t = String(out || '');
      if (!/unsafe/i.test(t)) return true;
      return !(t.toUpperCase().match(/S\d+/g) || []).some((c) => GUARD_BAD.includes(c));
    } catch (e) { return null; }
  }
  // Twitch info the YouTube checks need: channel labels and game names
  async policyMeta(bids, gids) {
    const chans = {}, games = {};
    bids = [...new Set(bids.filter(Boolean))]; gids = [...new Set(gids.filter(Boolean))];
    for (let i = 0; i < bids.length; i += 100) { try { for (const c of (await this.helix('/channels', { query: { broadcaster_id: bids.slice(i, i + 100) } })).data || []) chans[c.broadcaster_id] = c; } catch (e) {} }
    for (let i = 0; i < gids.length; i += 100) { try { for (const g of (await this.helix('/games', { query: { id: gids.slice(i, i + 100) } })).data || []) games[g.id] = g.name; } catch (e) {} }
    return { chans, games };
  }
  // Why a clip can't go on YouTube ('' = fine)
  skipWhy(meta, { bid, game, title }) {
    const labels = ((meta.chans[bid] || {}).content_classification_labels) || [];
    return SKIP_GAMES[String(game || '').toLowerCase()] || labels.map((l) => SKIP_LABELS[l]).find(Boolean) || (BAD_WORDS.test(title || '') ? 'gambling or promo codes' : '');
  }
  warnings(meta, bid) {
    const ch = meta.chans[bid] || {}, w = (ch.content_classification_labels || []).map((l) => WARN_LABELS[l]).filter(Boolean);
    if (ch.is_branded_content) w.push('a sponsor, so cut any sponsor logos, links or codes');
    return w;
  }
  /* ---------------- Learn from your YouTube results ---------------- */
  // Reads your channel's recent Shorts once a day, works out which streamers do well for you,
  // and gives the daily queue a gentle push toward them (x0.75 to x1.35).
  async learnResults(force) {
    if (!this.cfg.ytKey || !this.cfg.ytChannel) return { needSetup: true };
    if (!force && this.results && this.now() - this.results.at < 20 * 3600 * 1000) return this.results;
    const h = this.cfg.ytChannel;
    const ch = await this.yt('channels', h.startsWith('@') ? { part: 'contentDetails,snippet', forHandle: h } : { part: 'contentDetails,snippet', id: h }, 1);
    const c = (ch.items || [])[0];
    if (!c) throw new Error("Couldn't find that YouTube channel. Check the handle.");
    const pl = await this.yt('playlistItems', { part: 'contentDetails', playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: '50' }, 1);
    const ids = (pl.items || []).map((x) => x.contentDetails.videoId).filter(Boolean);
    const vids = ids.length ? (await this.yt('videos', { part: 'snippet,statistics', id: ids.join(',') }, 1)).items || [] : [];
    const old = vids.filter((v) => this.now() - Date.parse(v.snippet.publishedAt) > 24 * 3600 * 1000); // give each video a day before judging it
    const match = (v) => {
      const t = (v.snippet.title + ' ' + v.snippet.description).toLowerCase();
      return this.cfg.streamers.find((st) => (st.login && t.includes('twitch.tv/' + st.login.toLowerCase())) || t.includes(String(st.name || '').toLowerCase()) || (st.login && t.includes(st.login.toLowerCase())));
    };
    const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
    const views = (v) => +((v.statistics || {}).viewCount || 0);
    const all = med(old.map(views)) || 1, per = {};
    const owner = new Map();
    for (const v of old) { const st = match(v); owner.set(v.id, st ? st.id : null); if (!st) continue; (per[st.id] = per[st.id] || { name: st.name, views: [], best: null }).views.push(views(v)); if (!per[st.id].best || views(v) > views(per[st.id].best)) per[st.id].best = v; }
    const streamers = {};
    for (const [id, p] of Object.entries(per)) {
      const m = med(p.views), n = p.views.length;
      // compare against your other videos (not counting this streamer's own)
      const others = old.filter((v) => owner.get(v.id) !== id).map(views), base = others.length >= 2 ? med(others) || 1 : all;
      // only trust it after 2+ videos, and lean on it more as you post more
      const raw = Math.sqrt(Math.max(m, 1) / base), w = Math.min(1, (n - 1) / 4);
      streamers[id] = { name: p.name, videos: n, median: m, factor: n >= 2 ? Math.round(Math.max(0.75, Math.min(1.35, 1 + (raw - 1) * w)) * 100) / 100 : 1,
        best: p.best ? { title: p.best.snippet.title, views: views(p.best), url: `https://youtube.com/shorts/${p.best.id}` } : null };
    }
    const top = [...vids].sort((a, b) => views(b) - views(a)).slice(0, 3).map((v) => ({ title: v.snippet.title, views: views(v), url: `https://youtube.com/shorts/${v.id}` }));
    this.results = { at: this.now(), channel: c.snippet.title, videos: vids.length, judged: old.length, median: old.length ? all : 0, streamers, top };
    await this.st.put('results', this.results);
    return this.results;
  }
  async makeQueue(preview) {
    const n = this.cfg.queueCount || 8, since = this.now() - 26 * 3600 * 1000, items = [], skipped = [];
    const editor = new Set(this.cfg.streamers.filter((s) => s.editor === true).map((s) => s.id));
    const started = new Date(this.now() - 72 * 3600 * 1000).toISOString();
    const raw = (await Promise.all(this.cfg.streamers.map((s) => this.helix('/clips', { query: { broadcaster_id: s.id, started_at: started, first: '100' } }).then((j) => j.data || []).catch(() => [])))).flat();
    await this.fillVodGuess(raw);
    const mine = this.clips.filter((x) => x.status === 'ready' && x.at >= since).slice(0, 20);
    const meta = await this.policyMeta([...this.cfg.streamers.map((s) => s.id), ...mine.map((c) => c.broadcaster_id)], raw.map((c) => c.game_id));
    // 1) your own auto clips from the last day
    for (const c of mine) {
      const why = this.skipWhy(meta, { bid: c.broadcaster_id, game: c.game, title: c.title });
      if (why) { skipped.push(why); continue; }
      items.push({ kind: 'mine', id: c.id, name: c.name, login: c.login, title: c.title || 'stream moment', why: c.why, chat: (c.top || []).join(', '), game: c.game || '', streamTitle: c.streamTitle || '', vod: this.vodLink(c.video, c.vodOffset), bid: c.broadcaster_id, url: c.url, thumb: c.thumb, score: 70 + (c.manual ? 5 : 0), ready: editor.has(c.broadcaster_id) });
    }
    // 2) the best moments other viewers clipped (rule-breaking clips never count)
    const bad = new Set();
    for (const c of raw) { const why = this.skipWhy(meta, { bid: c.broadcaster_id, game: meta.games[c.game_id], title: c.title }); if (why) { bad.add(c.id); if (Date.parse(c.created_at) >= since) skipped.push(why); } }
    const loginOf = (id) => (this.cfg.streamers.find((s) => s.id === id) || {}).login || '';
    const toItem = (m) => { const c = m.best, off = c.vod_offset; return { kind: 'pick', id: c.id, name: c.broadcaster_name, login: loginOf(c.broadcaster_id), title: c.title, why: m.why.join(', ') || `${numFmt(m.views)} views`, chat: '', game: meta.games[c.game_id] || '', vid: c.video_id || '', bid: c.broadcaster_id, url: c.url, thumb: c.thumbnail_url, score: m.score,
      vod: c.video_id && off != null ? `https://www.twitch.tv/videos/${c.video_id}?t=${Math.floor(off / 3600)}h${Math.floor(off % 3600 / 60)}m${Math.floor(off % 60)}s` : '', ready: false, editor: editor.has(c.broadcaster_id) }; };
    const checked = new Map(); // clip id -> guard verdict on its title
    const guardItems = async (list) => { await Promise.all(list.filter((it) => !checked.has(it.id)).map(async (it) => checked.set(it.id, await this.guard(`Twitch clip title: ${it.title}`)))); };
    await guardItems(items);
    for (let round = 0; round < 3; round++) {
      const picks = bestMoments(raw.filter((c) => !bad.has(c.id)), this.now(), (c) => Date.parse(c.created_at) >= since, n).map(toItem);
      await guardItems(picks);
      const flagged = picks.filter((it) => checked.get(it.id) === false);
      if (!flagged.length || round === 2) { items.push(...picks.filter((it) => checked.get(it.id) !== false)); break; }
      for (const it of flagged) bad.add(it.id);
    }
    const kept = items.filter((it) => checked.get(it.id) !== false);
    for (const it of items) if (checked.get(it.id) === false && it.kind === 'mine') skipped.push('the clip title breaks YouTube rules');
    skipped.push(...[...bad].filter((id) => checked.get(id) === false).map(() => 'the clip title breaks YouTube rules'));
    const skipNote = skipped.length ? `Skipped ${skipped.length} clip${skipped.length > 1 ? 's' : ''} for YouTube rules (${[...new Set(skipped)].join(', ')}).` : '';
    if (skipNote) this.addLog('Queue ' + skipNote.charAt(0).toLowerCase() + skipNote.slice(1));
    // campaign streamers first (they pay), then what has worked on your channel
    const byId = new Map(this.cfg.streamers.map((x) => [x.id, x]));
    if (!preview) await this.learnResults(false).catch(() => {});
    for (const it of kept) {
      const st = byId.get(it.bid) || {};
      it.campaign = st.campaign || null;
      if (it.campaign) it.score += 20;
      const r = this.results && this.results.streamers && this.results.streamers[it.bid];
      if (r && r.factor) { it.score = Math.round(it.score * r.factor); it.resultsNote = r.factor > 1.05 ? 'does well on your channel' : r.factor < 0.95 ? 'usually gets fewer views for you' : ''; }
    }
    const per = {}, chosen = [];
    for (const it of kept.sort((a, b) => b.score - a.score)) { if ((per[it.name] = (per[it.name] || 0) + 1) > 3) continue; it.warn = this.warnings(meta, it.bid); chosen.push(it); if (chosen.length >= n) break; }
    if (!chosen.length) {
      await this.discord({ username: 'ClipKit Queue', content: "**🎬 Today's video queue:** nothing strong enough today. Quiet streams. Check back tomorrow." }, this.cfg.postsHook);
      this.queue = { at: this.now(), items: [] }; await this.st.put('queue', this.queue);
      return { ok: true, count: 0 };
    }
    // more to go on: the stream's title and what the clip's frame shows
    const vids = [...new Set(chosen.filter((it) => it.vid && !it.streamTitle).map((it) => it.vid))];
    if (vids.length) { try { const vt = {}; for (const v of (await this.helix('/videos', { query: { id: vids } })).data || []) vt[v.id] = v.title; chosen.forEach((it) => { if (!it.streamTitle && vt[it.vid]) it.streamTitle = vt[it.vid]; }); } catch (e) {} }
    const scenes = await Promise.all(chosen.map((it) => this.describeFrame(it.thumb)));
    chosen.forEach((it, i) => { it.scene = scenes[i]; });
    const copy = await this.writeCopy(chosen);
    const times = this.slotTimes(chosen.length);
    const clean = (t) => String(t || '').replace(BAD_WORDS, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    chosen.forEach((it, i) => {
      const w = copy && copy.find((x) => +x.n === i + 1);
      const titles = w && Array.isArray(w.titles) ? w.titles.map((t) => clean(t).slice(0, 100)).filter((t) => t.length >= 8) : [];
      it.titles = titles.length ? [...new Set(titles)].slice(0, 3) : [clean(it.title).slice(0, 100) || `${it.name} stream moment`];
      it.description = (w && w.description ? clean(w.description).slice(0, 400) : `${it.name} on stream.`) + '\n' + (it.campaign && it.campaign.credit ? it.campaign.credit : `Clip from ${it.name}'s stream${it.login ? `: twitch.tv/${it.login}` : ''}. All credit to ${it.name}.`);
      const tags = (w && Array.isArray(w.hashtags) ? w.hashtags : []).map((t) => '#' + String(t).replace(/[^\p{L}\p{N}_]/gu, '')).filter((t) => t.length > 2 && !BAD_WORDS.test(t) && !/^#(fyp|foryou|foryoupage|viral|trending|explore|xyzbca|blowup)$/i.test(t));
      const seen = new Set(), need = it.campaign ? it.campaign.tags : [];
      it.hashtags = ['#shorts', ...need, ...tags, ...(it.login ? ['#' + it.login] : [])].filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, Math.max(5, need.length + 1));
      it.angle = w && w.angle ? clean(w.angle).slice(0, 200) : '';
      it.postAt = times[i];
    });
    // last check on what the AI wrote; anything flagged goes back to a plain title
    const vs = await Promise.all(chosen.map((it) => this.guard(`${it.titles.join('\n')}\n${it.description}\n${it.hashtags.join(' ')}\n${it.angle}`)));
    chosen.forEach((it, i) => { if (vs[i] === false) { it.titles = [`${it.name} stream moment`]; it.description = `Clip from ${it.name}'s stream${it.login ? `: twitch.tv/${it.login}` : ''}. All credit to ${it.name}.`; it.hashtags = ['#shorts', ...(it.campaign ? it.campaign.tags : []), ...(it.login ? ['#' + it.login] : [])]; if (it.campaign && it.campaign.credit) it.description = it.campaign.credit; it.angle = ''; } });
    if (preview) return { ok: true, frameErr: this.frameErr || '', thumbs: chosen.map((it) => it.thumb), preview: chosen.map((it) => ({ name: it.name, campaign: it.campaign && it.campaign.name, description: it.description, game: it.game, streamTitle: it.streamTitle, scene: it.scene, titles: it.titles, hashtags: it.hashtags, angle: it.angle })) };
    this.queue = { at: this.now(), items: chosen }; await this.st.put('queue', this.queue);
    const how = (it) => it.ready ? '📥 **Ready:** pull it into ClipKit Batch with *Get clips from my auto clipper*.'
      : it.kind === 'mine' ? '📥 Download it from your Clips Manager (Clips I\'ve created), then add it in ClipKit Batch.' + (it.vod ? ` Or [clip it yourself from the VOD](${it.vod}).` : '')
      : it.editor ? '✂️ Open Trending → Find the best clips and tap **Clip it now**, then pull it into Batch.'
      : it.vod ? `✂️ [Clip it yourself from the VOD](${it.vod}), then download it from your Clips Manager.` : '';
    const embeds = chosen.map((it, i) => ({
      title: `${i + 1}. ${it.titles[0]}`.slice(0, 250), url: it.url, color: 0xff4f5e,
      description: [`**Post at ${it.postAt}** · ${it.name} · ${it.why}`,
        it.titles.length > 1 ? `**Other titles:**\n${it.titles.slice(1).map((t) => '• ' + t).join('\n')}` : '',
        `**Description:**\n${it.description}\n${it.hashtags.join(' ')}`,
        it.angle ? `🎙️ **Add your take:** ${it.angle}` : '',
        it.warn && it.warn.length ? `⚠️ **Heads up:** this channel is marked for ${it.warn.join('; ')}.` : '',
        it.campaign ? `💰 **Campaign: ${it.campaign.name}**${it.campaign.rules ? `\n${it.campaign.rules}` : ''}\nSubmit the link on Content Rewards after you post.` : '',
        it.resultsNote ? `📈 ${it.name} ${it.resultsNote}.` : '', how(it)].filter(Boolean).join('\n\n').slice(0, 1500),
      thumbnail: it.thumb ? { url: it.thumb } : undefined
    }));
    const { day } = this.localNow();
    for (let i = 0; i < embeds.length; i += 4) {
      await this.discord({ username: 'ClipKit Queue', content: i === 0 ? `**🎬 Today's video queue (${day})**: ${chosen.length} videos, best first. Post times are suggestions.\n**Before each post (YouTube rules):**\n• Watch the whole clip. Skip it if there's nudity, slurs, real violence or a gambling site on screen.\n• Add your own take (caption, voiceover or edit). Plain reposts can't earn money on YouTube.\n• Cut or mute any copyrighted music.\n• Only post streamers who allow clip channels, and keep the credit line.${skipNote ? `\n_${skipNote}_` : ''}` : undefined, embeds: embeds.slice(i, i + 4) }, this.cfg.postsHook);
    }
    this.addLog(`Sent today's video queue (${chosen.length} videos) to Discord.`);
    return { ok: true, count: chosen.length };
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
