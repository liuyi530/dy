const ALLOW_ORIGIN = '*';

let lastReceivedCookie = '';

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

  // ★ 关键修复：补全音频类型
  const isAudio = /\.(mp3|m4a|aac|flac|wav|ogg|opus)(\?|#|$)/i.test(target) ||
                  /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(pathLower);

  const isVideoChunk = /\.(ts|mp4|flv|key|m4s)(\?|#|$)/i.test(target) ||
                       /\.(ts|mp4|flv|key|m4s)$/i.test(pathLower);

  // 网易云外链走特殊路径（带 song/media/outer）
  const isNeteaseOuter = /music\.163\.com\/song\/media\/outer/i.test(target);

  const isMedia = isM3U8 || isAudio || isVideoChunk || isNeteaseOuter;

  const isApiPath = /\/api\//i.test(targetUrl.pathname) ||
                    /\/v[0-9]+\//i.test(targetUrl.pathname) ||
                    /\/ndsx\.php/i.test(targetUrl.pathname) ||
                    /\/api\.php/i.test(targetUrl.pathname);

  const isIframeReq = u.searchParams.get('iframe') === '1';

  // 前端可指定 Header（可选）
  const customReferer = request.headers.get('x-target-referer') || '';
  const customAccept  = request.headers.get('x-target-accept')  || '';
  const customCookie  = request.headers.get('x-target-cookie')  || '';

  const effectiveCookie = customCookie || lastReceivedCookie;

  const isApiRequest = isApiPath || /application\/json/i.test(customAccept);

  /* ========== 构造请求 Header ========== */
  const reqHeaders = new Headers({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  });

  if (isMedia) {
    // ★ 音频/视频：完全模拟浏览器媒体请求
    reqHeaders.set('Accept', '*/*');
    reqHeaders.set('Sec-Fetch-Dest', 'audio');           // 音频用 audio，视频用 video，这里统一 audio 也行
    reqHeaders.set('Sec-Fetch-Mode', 'no-cors');         // 媒体请求是 no-cors
    reqHeaders.set('Sec-Fetch-Site', 'cross-site');

    // ★ 关键：网易云外链必须带 Referer + Origin
    if (isNeteaseOuter) {
      reqHeaders.set('Referer', customReferer || 'https://music.163.com/');
      reqHeaders.set('Origin', 'https://music.163.com');
    } else if (customReferer) {
      reqHeaders.set('Referer', customReferer);
      try { reqHeaders.set('Origin', new URL(customReferer).origin); } catch (e) {}
    } else {
      reqHeaders.set('Referer', targetOrigin + '/');
    }

    // 允许 Range 透传（拖动进度条需要）
    const range = request.headers.get('range');
    if (range) reqHeaders.set('Range', range);

  } else if (isApiRequest) {
    reqHeaders.set('Accept', customAccept || 'application/json, text/plain, */*');
    reqHeaders.set('Sec-Fetch-Dest', 'empty');
    reqHeaders.set('Sec-Fetch-Mode', 'cors');
    reqHeaders.set('Sec-Fetch-Site', 'cross-site');
    reqHeaders.set('Referer', customReferer || (targetOrigin + '/'));
    try { reqHeaders.set('Origin', new URL(customReferer || targetOrigin).origin); } catch (e) {
      reqHeaders.set('Origin', targetOrigin);
    }

  } else {
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

  if (effectiveCookie) {
    reqHeaders.set('Cookie', effectiveCookie);
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

    // ① M3U8：重写分片链接
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

    // ② JSON / API：透传二进制
    if (respIsJson) {
      const body = await resp.arrayBuffer();
      headers.set('Content-Type', ct || 'application/json');
      headers.set('Cache-Control', 'no-store');

      const setCookieHeader = resp.headers.get('set-cookie');
      if (setCookieHeader) {
        headers.set('x-set-cookie', setCookieHeader);
        const m = setCookieHeader.match(/PHPSESSID=[^;]+/);
        if (m) lastReceivedCookie = m[0];
      }

      return new Response(body, { status: resp.status, headers });
    }

    // ★ ③ 音频/视频：流式透传，不要 arrayBuffer（大文件会爆内存）
    if (isMedia) {
      headers.set('Content-Type', ct || 'audio/mpeg');
      headers.set('Cache-Control', 'no-store');

      // 透传 Range 支持（206 分片）
      const contentRange = resp.headers.get('content-range');
      const acceptRanges = resp.headers.get('accept-ranges');
      const contentLength = resp.headers.get('content-length');
      if (contentRange) headers.set('Content-Range', contentRange);
      if (acceptRanges) headers.set('Accept-Ranges', acceptRanges);
      if (contentLength) headers.set('Content-Length', contentLength);

      return new Response(resp.body, { status: resp.status, headers });
    }

    // ④ HTML / 其他：二进制透传
    const body = await resp.arrayBuffer();
    if (ct) headers.set('Content-Type', ct);

    if (isIframeReq) {
      headers.set('X-Frame-Options', 'ALLOWALL');
      headers.set('Content-Security-Policy', "frame-ancestors *");
      headers.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    }

    const setCookieHeader = resp.headers.get('set-cookie');
    if (setCookieHeader) {
      headers.set('x-set-cookie', setCookieHeader);
      const m = setCookieHeader.match(/PHPSESSID=[^;]+/);
      if (m) lastReceivedCookie = m[0];
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
    'Access-Control-Expose-Headers': 'x-set-cookie, content-range, accept-ranges, content-length',
    'Access-Control-Max-Age': '86400',
  };
}