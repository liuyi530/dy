const ALLOW_ORIGIN = '*';

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors() });
  }

  const u = new URL(request.url);
  const target = u.searchParams.get('url');

  if (!target) {
    return new Response(JSON.stringify({ error: '缺少 url 参数' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }

  let targetOrigin = '';
  try { targetOrigin = new URL(target).origin; } catch {}

  const init = {
    method: request.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
      'Referer': target,
      'Origin': targetOrigin,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
    const ct = request.headers.get('content-type') || 'application/x-www-form-urlencoded';
    init.headers['Content-Type'] = ct;
  }

  let resp;
  try {
    resp = await fetch(target, init);
  } catch (e) {
    return new Response(JSON.stringify({ error: '转发失败: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }

  if ([301, 302, 303, 307, 308].includes(resp.status)) {
    const loc = resp.headers.get('location');
    if (loc) {
      const absLoc = loc.startsWith('http') ? loc : new URL(loc, target).toString();
      const newUrl = new URL(request.url);
      newUrl.searchParams.set('url', absLoc);
      return new Response(null, {
        status: resp.status,
        headers: { ...cors(), 'Location': newUrl.toString() }
      });
    }
  }

  const body = await resp.arrayBuffer();
  const headers = new Headers(cors());
  const ct = resp.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);

  headers.delete('x-frame-options');
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');

  return new Response(body, { status: resp.status, headers });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}
