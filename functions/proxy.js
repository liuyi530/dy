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

  let targetUrl;
  let targetOrigin = '';
  try {
    targetUrl = new URL(target);
    targetOrigin = targetUrl.origin;
  } catch {
    return new Response(JSON.stringify({ error: '无效的 url 参数' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }

  // 前端可指定 Referer（可选），默认用目标域
  const referer = request.headers.get('x-target-referer') || (targetOrigin + '/');

  // 判断是不是媒体资源（m3u8 / ts / mp4 / flv / key）
  const isMedia = /\.(m3u8|ts|mp4|flv|key)(\?|#|$)/i.test(targetUrl.pathname) ||
                  /\.(m3u8|ts|mp4|flv|key)(\?|#|$)/i.test(target);

  const reqHeaders = new Headers({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': referer,
  });

  if (isMedia) {
    reqHeaders.set('Accept', '*/*');
    reqHeaders.set('Sec-Fetch-Dest', 'empty');
    reqHeaders.set('Sec-Fetch-Mode', 'cors');
    reqHeaders.set('Sec-Fetch-Site', 'cross-site');
    reqHeaders.set('Origin', targetOrigin);
  } else {
    reqHeaders.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8');
    reqHeaders.set('Cache-Control', 'no-cache');
    reqHeaders.set('Pragma', 'no-cache');
    reqHeaders.set('Sec-Ch-Ua', '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"');
    reqHeaders.set('Sec-Ch-Ua-Mobile', '?0');
    reqHeaders.set('Sec-Ch-Ua-Platform', '"Windows"');
    reqHeaders.set('Sec-Fetch-Dest', 'document');
    reqHeaders.set('Sec-Fetch-Mode', 'navigate');
    reqHeaders.set('Sec-Fetch-Site', 'cross-site');
    reqHeaders.set('Sec-Fetch-User', '?1');
    reqHeaders.set('Upgrade-Insecure-Requests', '1');
  }

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
    const ct = resp.headers.get('content-type') || '';

    const headers = new Headers(cors());

    // ---------- 关键：m3u8 内容重写，让所有分片也走代理 ----------
    const isM3U8 = /mpegurl/i.test(ct) || /\.m3u8(\?|#|$)/i.test(target);

    if (isM3U8) {
      let text = await resp.text();
      const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);

      const toAbs = (raw) => {
        if (!raw) return raw;
        if (/^https?:\/\//i.test(raw)) return raw;
        if (raw.startsWith('//')) return targetUrl.protocol + raw;
        try { return new URL(raw, baseUrl).href; } catch { return raw; }
      };

      const rewrite = (raw) => {
        const abs = toAbs(raw);
        return '/proxy?url=' + encodeURIComponent(abs);
      };

      // EXT-X-KEY:URI="..."
      text = text.replace(/URI="([^"]+)"/g, (m, p1) => 'URI="' + rewrite(p1) + '"');

      // 普通行（分片、子 m3u8、#EXT-X-MAP 等）
      text = text.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) return line;
        return rewrite(t);
      }).join('\n');

      headers.set('Content-Type', 'application/vnd.apple.mpegurl');
      return new Response(text, { status: resp.status, headers });
    }

    // ---------- 其他资源原样返回 ----------
    const body = await resp.arrayBuffer();
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
