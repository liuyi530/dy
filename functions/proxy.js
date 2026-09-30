const ALLOW_ORIGIN = '*';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

  try {
    const targetUrl = new URL(target);
    
    // 构建标准的转发请求头，避免 Cloudflare fetch 抛异常 500
    const headers = new Headers();
    headers.set('User-Agent', UA);
    headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9');

    // 传递前端带过来的 Cookie
    const customCookie = request.headers.get('x-target-cookie') || request.headers.get('cookie');
    if (customCookie) {
      headers.set('Cookie', customCookie);
    }

    const init = {
      method: request.method,
      headers: headers,
      redirect: 'follow'
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
      const ct = request.headers.get('content-type');
      if (ct) headers.set('Content-Type', ct);
    }

    const resp = await fetch(targetUrl.toString(), init);

    const resHeaders = new Headers(cors());
    const ct = resp.headers.get('content-type');
    if (ct) resHeaders.set('Content-Type', ct);

    // 移除限制性 Header
    resHeaders.delete('x-frame-options');
    resHeaders.delete('content-security-policy');

    const body = await resp.arrayBuffer();
    return new Response(body, { status: resp.status, headers: resHeaders });

  } catch (e) {
    // 捕获所有异常，彻底消除 500 报错
    return new Response(JSON.stringify({ error: '源站连接失败: ' + e.message }), {
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
    'Access-Control-Max-Age': '86400',
  };
}
