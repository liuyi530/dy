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

  const pathLower = targetUrl.pathname.toLowerCase();

  /* ========== 请求类型判断 ========== */
  const isM3U8 = /\.m3u8(\?|#|$)/i.test(target) || /\.m3u8$/i.test(pathLower);
  const isMedia = isM3U8 ||
                  /\.(ts|mp4|flv|key|m4s|aac)(\?|#|$)/i.test(target) ||
                  /\.(ts|mp4|flv|key|m4s|aac)$/i.test(pathLower);

  // ★ 新增：API / JSON 接口识别（飞流视频走这里）
  //   判断依据：路径含 /api /v1 /v2 或 .php 接口，或前端明确声明
  const isApiPath = /\/api\//i.test(targetUrl.pathname) ||
                    /\/v[0-9]+\//i.test(targetUrl.pathname) ||
                    /\/ndsx\.php/i.test(targetUrl.pathname) ||
                    /\/api\.php/i.test(targetUrl.pathname);

  const isIframeReq = u.searchParams.get('iframe') === '1';
  // ★ 新增：小蜜蜂 vodplay 播放页，也当作 iframe 请求处理


  // 前端可指定 Header（可选）
  const customReferer = request.headers.get('x-target-referer') || '';
  const customAccept  = request.headers.get('x-target-accept')  || '';
  const customCookie  = request.headers.get('x-target-cookie')  || '';

  // ★ 判断是不是 API 请求：路径像 API，或前端声明 Accept 为 JSON
  const isApiRequest = isApiPath || /application\/json/i.test(customAccept);

  /* ========== 构造请求 Header ========== */
  const reqHeaders = new Headers({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  });

  if (isMedia) {
    // ① 媒体请求（.m3u8 / .ts / .mp4 ...）
    reqHeaders.set('Accept', '*/*');
    reqHeaders.set('Sec-Fetch-Dest', 'empty');
    reqHeaders.set('Sec-Fetch-Mode', 'cors');
    reqHeaders.set('Sec-Fetch-Site', 'cross-site');
    if (customReferer) {
      reqHeaders.set('Referer', customReferer);
      try { reqHeaders.set('Origin', new URL(customReferer).origin); } catch(e){}
    }

  } else if (isApiRequest) {
    // ② API / JSON 请求（飞流视频等）
    //    - 优先用前端指定的 Accept
    //    - 默认 application/json
    reqHeaders.set('Accept', customAccept || 'application/json, text/plain, */*');
    reqHeaders.set('Sec-Fetch-Dest', 'empty');
    reqHeaders.set('Sec-Fetch-Mode', 'cors');
    reqHeaders.set('Sec-Fetch-Site', 'cross-site');
    // Referer / Origin：优先用前端指定的，否则用 target origin
    reqHeaders.set('Referer', customReferer || (targetOrigin + '/'));
    try { reqHeaders.set('Origin', new URL(customReferer || targetOrigin).origin); } catch(e){
      reqHeaders.set('Origin', targetOrigin);
    }

  } else {
    // ③ HTML 请求（磁力熊 / 非凡 / 奈飞 的搜索、详情页）
    reqHeaders.set('Accept', customAccept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8');
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
    reqHeaders.set('Referer', customReferer || (targetOrigin + '/'));
  }

  if (customCookie) {
    reqHeaders.set('Cookie', customCookie);
  }

  /* ========== 发请求 ========== */
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

    const respIsM3U8 = isM3U8 || /mpegurl/i.test(ct);
    const respIsJson = /application\/json/i.test(ct) || isApiRequest;

    /* ========== 响应处理 ========== */

    // ① M3U8：重写分片链接，走代理
    if (respIsM3U8) {
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
        if (abs.includes('/proxy?url=')) return abs;
        return '/proxy?url=' + encodeURIComponent(abs);
      };

      text = text.replace(/URI="([^"]+)"/g, (m, p1) => 'URI="' + rewrite(p1) + '"');

      text = text.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) return line;
        return rewrite(t);
      }).join('\n');

      headers.set('Content-Type', 'application/vnd.apple.mpegurl');
      headers.set('Cache-Control', 'no-store');
      return new Response(text, { status: resp.status, headers });
    }

    // ② JSON / API：直接透传二进制，不重写
    if (respIsJson) {
      const body = await resp.arrayBuffer();
      headers.set('Content-Type', ct || 'application/json');
      headers.set('Cache-Control', 'no-store');

      const setCookieHeader = resp.headers.get('set-cookie');
      if (setCookieHeader) {
        headers.set('x-set-cookie', setCookieHeader);
      }

      return new Response(body, { status: resp.status, headers });
    }

    // ③ HTML / 其他：二进制透传
    const body = await resp.arrayBuffer();
    if (ct) headers.set('Content-Type', ct);

// iframe 嵌入（视频解析用）
if (isIframeReq) {
  headers.set('X-Frame-Options', 'ALLOWALL');
  headers.set('Content-Security-Policy', "frame-ancestors *");
  headers.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
}

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