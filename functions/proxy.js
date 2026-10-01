const ALLOW_ORIGIN = '*';

// 需要自动获取 cookie 的站点
const COOKIE_HOSTS = {
  'www.dushe3.app': {
    home: 'https://www.dushe3.app/',
    cookieName: 'cdndefend_js_cookie',
  },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

  // ===== 自动获取或刷新 cookie =====
  let autoCookie = '';
  if (COOKIE_HOSTS[targetHost]) {
    autoCookie = await getHostCookie(targetHost);
  }

  const init = {
    method: request.method,
    headers: {
      'User-Agent': UA,
      // 修复点 1：Referer 统一设为目标站首页，避免直接设为 API 地址导致拦截
      'Referer': targetOrigin ? targetOrigin + '/' : target,
      'Origin': targetOrigin,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    // 修复点 2：自动跟随重定向，防止源站 302 导致中转报错 502
    redirect: 'follow',
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

  // 目标返回新的 Set-Cookie 时自动解析并缓存
  if (COOKIE_HOSTS[targetHost]) {
    // 修复点 3：兼容 Cloudflare 多重 Set-Cookie 提取
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie') || ''];
    const name = COOKIE_HOSTS[targetHost].cookieName;
    for (const sc of setCookies) {
      if (!sc) continue;
      const m = sc.match(new RegExp(name + '=[^;]+'));
      if (m) {
        await cacheCookie(targetHost, m[0]);
        break;
      }
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
  try {
    const cached = await cache.match(cookieCacheKey(host));
    if (cached) {
      const txt = await cached.text();
      if (txt) return txt;
    }
  } catch (e) {}
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

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    let targetCookie = '';

    for (const sc of setCookies) {
      if (!sc) continue;
      const m = sc.match(new RegExp(cfg.cookieName + '=[^;]+'));
      if (m) {
        targetCookie = m[0];
        break;
      }
    }

    if (!targetCookie) {
      console.warn('首页未返回目标 cookie');
      return '';
    }

    await cacheCookie(host, targetCookie);
    return targetCookie;
  } catch (e) {
    console.error('获取 cookie 失败:', e);
    return '';
  }
}

async function cacheCookie(host, cookie) {
  try {
    const cache = caches.default;
    const resp = new Response(cookie, {
      headers: {
        'Cache-Control': 'max-age=1800',
        'Content-Type': 'text/plain',
      },
    });
    await cache.put(cookieCacheKey(host), resp);
  } catch (e) {}
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
