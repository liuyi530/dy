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
  try {
    const t = new URL(target);
    targetOrigin = t.origin;
  } catch {
    return new Response(JSON.stringify({ error: '无效的 url 参数' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }

  // 模拟标准现代浏览器 Header，避免被目标站或 Cloudflare 防护拦截
  const reqHeaders = new Headers({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': targetOrigin + '/'
  });

  const customCookie = request.headers.get('x-target-cookie') || '';
  if (customCookie) {
    reqHeaders.set('Cookie', customCookie);
  }

  const init = {
    method: request.method,
    headers: reqHeaders,
    redirect: 'follow',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
    const ct = request.headers.get('content-type') || 'application/x-www-form-urlencoded';
    reqHeaders.set('Content-Type', ct);
  }

  try {
    const resp = await fetch(target, init);
    const body = await resp.arrayBuffer();
    const headers = new Headers(cors());

    const ct = resp.headers.get('content-type');
    if (ct) headers.set('Content-Type', ct);

    const setCookieHeader = resp.headers.get('set-cookie');
    if (setCookieHeader) {
      headers.set('x-set-cookie', setCookieHeader);
    }

    return new Response(body, { status: resp.status, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: '代理转发失败: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }
}

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'x-set-cookie',
    'Access-Control-Max-Age': '86400',
  };
}
