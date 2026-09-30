const ALLOW_ORIGIN = '*';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

// 使用 Worker 内存存储 Cookie，彻底替代触发 500 的 Cache API
const cookieStore = new Map();

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
    return await fetchWithAutoProxy(target, request);
  } catch (e) {
    return new Response(JSON.stringify({ error: '中转执行异常: ' + e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }
}

async function fetchWithAutoProxy(target, request) {
  let targetOrigin = '', targetHost = '';
  try {
    const t = new URL(target);
    targetOrigin = t.origin;
    targetHost = t.host;
  } catch {}

  const initHeaders = {
    'User-Agent': UA,
    'Referer': target,
    'Origin': targetOrigin,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  // 自动注入之前解析出的 Cookie
  if (cookieStore.has(targetHost)) {
    initHeaders['Cookie'] = cookieStore.get(targetHost);
  }

  const init = {
    method: request.method,
    headers: initHeaders,
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
    init.headers['Content-Type'] = request.headers.get('content-type') || 'application/x-www-form-urlencoded';
  }

  let resp = await fetch(target, init);

  // 处理 HTTP 30x 重定向
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

  // 读取响应头中的 Set-Cookie
  const setCookie = resp.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/cdndefend_js_cookie=[^;]+/);
    if (m) cookieStore.set(targetHost, m[0]);
  }

  // 判定是否命中前端 JS 防火墙（5秒盾）
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const text = await resp.text();

    if (text.includes('cdndefend_js_cookie')) {
      const solvedCookie = parseJsCookie(text);
      if (solvedCookie) {
        cookieStore.set(targetHost, solvedCookie);

        // 自动带上破解出的 Cookie 二次无感重新请求
        init.headers['Cookie'] = solvedCookie;
        resp = await fetch(target, init);
        
        const secondBody = await resp.arrayBuffer();
        return buildResponse(secondBody, resp);
      }
    }
    return buildResponse(new TextEncoder().encode(text), resp);
  }

  const body = await resp.arrayBuffer();
  return buildResponse(body, resp);
}

// 在 Worker 端自动正则提取/计算 cdndefend_js_cookie
function parseJsCookie(html) {
  try {
    // 提取脚本中的 Cookie 直接赋值或运算式
    const matchDirect = html.match(/cdndefend_js_cookie\s*=\s*['"]?([^'";]+)['"]?/i) ||
                        html.match(/cookie\s*=\s*['"](cdndefend_js_cookie=[^;'"]+)['"]/i);
    if (matchDirect && matchDirect[1]) {
      return matchDirect[1].includes('=') ? matchDirect[1] : `cdndefend_js_cookie=${matchDirect[1]}`;
    }

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
    if (scriptMatch) {
      const code = scriptMatch[1];
      const valMatch = code.match(/cdndefend_js_cookie=['"]?([a-zA-Z0-9%_-]+)/);
      if (valMatch) {
        return `cdndefend_js_cookie=${valMatch[1]}`;
      }
    }
  } catch (e) {
    console.error('JS Challenge 自动破盾失败:', e);
  }
  return null;
}

function buildResponse(body, resp) {
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
