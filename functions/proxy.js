const ALLOW_ORIGIN = '*';

// 需要自动获取 cookie 的站点
const COOKIE_HOSTS = {
  'www.dushe3.app': {
    home: 'https://www.dushe3.app/',
    cookieName: 'cdndefend_js_cookie',
  },
};

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

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
  let targetHost = '';
  try {
    const t = new URL(target);
    targetOrigin = t.origin;
    targetHost = t.host;
  } catch {}

  // ===== 关键：自动获取 cookie =====
  let autoCookie = '';
  if (COOKIE_HOSTS[targetHost]) {
    autoCookie = await getHostCookie(targetHost);
  }

  const init = {
    method: request.method,
    headers: {
      'User-Agent': UA,
      'Referer': target,
      'Origin': targetOrigin,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'manual',
  };

  const manualCookie = request.headers.get('x-target-cookie') || '';
  if (manualCookie) {
    init.headers['Cookie'] = manualCookie;
  } else if (autoCookie) {
    init.headers['Cookie'] = autoCookie;
  }

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

  // 目标返回新的 Set-Cookie，更新缓存
  if (COOKIE_HOSTS[targetHost]) {
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) {
      const name = COOKIE_HOSTS[targetHost].cookieName;
      const m = setCookie.match(new RegExp(name + '=[^;]+'));
      if (m) await cacheCookie(targetHost, m[0]);
    }
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

/* ========== cookie 缓存 ========== */

async function getHostCookie(host) {
  const cache = caches.default;
  const cached = await cache.match(cookieCacheKey(host));
  if (cached) {
    const txt = await cached.text();
    if (txt) return txt;
  }
  return await refreshHostCookie(host);
}

async function refreshHostCookie(host) {
  const cfg = COOKIE_HOSTS[host];
  if (!cfg) return '';
  try {
    const res = await fetch(cfg.home, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'follow',
    });
    const raw = res.headers.get('set-cookie') || '';
    const m = raw.match(new RegExp(cfg.cookieName + '=[^;]+'));
    if (!m) {
      console.warn('首页未返回目标 cookie:', raw);
      return '';
    }
    await cacheCookie(host, m[0]);
    return m[0];
  } catch (e) {
    console.error('获取 cookie 失败:', e);
    return '';
  }
}

async function cacheCookie(host, cookie) {
  const cache = caches.default;
  const resp = new Response(cookie, {
    headers: {
      'Cache-Control': 'max-age=1800',
      'Content-Type': 'text/plain',
    },
  });
  await cache.put(cookieCacheKey(host), resp);
}

function cookieCacheKey(host) {
  return new Request('https://cookie-cache.internal/' + host);
}

/* ========== CORS ========== */

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}