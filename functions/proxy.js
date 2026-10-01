const ALLOW_ORIGIN = '*';

const COOKIE_HOSTS = {
  'www.dushe3.app': {
    home: 'https://www.dushe3.app/',
    cookieName: 'cdndefend_js_cookie',
  },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function onRequest(context) {
  const { request } = context;

  // 预检请求直接返回 CORS
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
  } catch {
    return new Response(JSON.stringify({ error: '无效的 url 参数' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }

  // ===== 自动获取或刷新 cookie =====
  let autoCookie = '';
  if (COOKIE_HOSTS[targetHost]) {
    autoCookie = await getHostCookie(targetHost, u.origin);
  }

  const init = {
    method: request.method,
    headers: {
      'User-Agent': UA,
      'Referer': targetOrigin ? targetOrigin + '/' : target,
      'Origin': targetOrigin,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'follow',
  };

  // 优先读取前端透传的自定义 cookie；若无则使用自动获取的 cookie
  const manualCookie = request.headers.get('x-target-cookie') || '';
  if (manualCookie) {
    init.headers['Cookie'] = manualCookie;
  } else if (autoCookie) {
    init.headers['Cookie'] = autoCookie;
  }

  // 非 GET/HEAD 请求转发 Request Body
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

  // 目标站返回新的 Set-Cookie 时自动解析并更新缓存
  if (COOKIE_HOSTS[targetHost]) {
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie') || ''];
    const name = COOKIE_HOSTS[targetHost].cookieName;
    for (const sc of setCookies) {
      if (!sc) continue;
      const m = sc.match(new RegExp(name + '=[^;]+'));
      if (m) {
        await cacheCookie(targetHost, m[0], u.origin);
        break;
      }
    }
  }

  const body = await resp.arrayBuffer();
  const headers = new Headers(cors());
  const ct = resp.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);

  // 清除源站限制外嵌的安全响应标头（修正参数传递）
  headers.delete('x-frame-options');
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');

  return new Response(body, { status: resp.status, headers });
}

/* ========== Cookie 缓存逻辑 (修正 URL 域名与异常防爆) ========== */

async function getHostCookie(host, appOrigin) {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const cached = await caches.default.match(cookieCacheKey(host, appOrigin));
      if (cached) {
        const txt = await cached.text();
        if (txt) return txt;
      }
    }
  } catch (e) {}
  return await refreshHostCookie(host, appOrigin);
}

async function refreshHostCookie(host, appOrigin) {
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

    if (!targetCookie) return '';

    await cacheCookie(host, targetCookie, appOrigin);
    return targetCookie;
  } catch (e) {
    return '';
  }
}

async function cacheCookie(host, cookie, appOrigin) {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const resp = new Response(cookie, {
        headers: {
          'Cache-Control': 'max-age=1800',
          'Content-Type': 'text/plain',
        },
      });
      await caches.default.put(cookieCacheKey(host, appOrigin), resp);
    }
  } catch (e) {}
}

// 必须使用当前 App 站点的合法绝对路径，不能使用 internal 伪协议
function cookieCacheKey(host, appOrigin) {
  return new Request(`${appOrigin}/__cache_cookie__/${encodeURIComponent(host)}`);
}

/* ========== CORS 配置 ========== */

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}
