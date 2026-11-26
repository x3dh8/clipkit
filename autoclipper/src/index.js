import PAGE from './page.html';
export { Watcher } from './watcher.js';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.WATCHER.get(env.WATCHER.idFromName('main'));
      return stub.fetch(req);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
    return new Response('Not found', { status: 404 });
  }
};
