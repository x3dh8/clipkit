import PAGE from './page.html';
export { Watcher } from './watcher.js';
const ALLOWED = ['https://x3dh8.github.io'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      // ClipKit (on GitHub Pages) may call the API to pull clips into Batch
      const origin = req.headers.get('origin');
      const cors = ALLOWED.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'x-clipkit-key, content-type', 'access-control-allow-methods': 'GET, POST', 'access-control-expose-headers': 'x-clip-name', vary: 'origin' } : null;
      if (req.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
      const stub = env.WATCHER.get(env.WATCHER.idFromName('main'));
      const res = await stub.fetch(req);
      if (!cors) return res;
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
    return new Response('Not found', { status: 404 });
  }
};
