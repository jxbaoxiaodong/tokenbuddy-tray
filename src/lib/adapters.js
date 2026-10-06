'use strict';

/*
 * 余额适配器。目标:适配绝大多数中转站。
 * 主流中转站基本是两套协议:
 *   - Sub2API   : GET /v1/usage                (API Key 直查账户钱包余额)
 *                 POST /api/v1/auth/login       (账号密码,返回 JWT)
 *   - New API / One API : GET /api/status       (公开端点,用于识别协议)
 *                         POST /api/user/login   (账号密码,返回 JWT + 完整 user 对象)
 *                         GET /v1/dashboard/billing/subscription (API Key;注意是"总额度"不是余额)
 *
 * 协议识别只凭 API Base URL,不消耗任何凭据,全部是未鉴权的单次 GET/POST。
 * 需要账户余额时走纯 HTTP 登录,不启动浏览器。
 */

const UA = 'TokenBuddyTray/0.1';
const DEFAULT_TIMEOUT = 15000;
const NEWAPI_QUOTA_PER_UNIT = 500000; // New API 默认值;实际以站点 /api/status 的 quota_per_unit 为准
// 无限额度响应使用固定哨兵值,与真实余额无关。
const NEWAPI_UNLIMITED_SENTINEL = 100000000;
// 登录会话不能按刷新频率重复创建。令牌只在主进程内存中缓存,
// 持久化由主进程写入 Electron safeStorage;刷新时优先复用会话。
const ACCOUNT_SESSIONS = new Map();
const LOGIN_COOLDOWNS = new Map();
const AUTH_INFLIGHT = new Map();
const MIN_LOGIN_COOLDOWN_MS = 60 * 1000;
const MAX_LOGIN_COOLDOWN_MS = 15 * 60 * 1000;

function stripSlash(u) {
  const raw = String(u || '').trim();
  try {
    const parsed = new URL(raw);
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch (e) {
    return raw.replace(/\/+$/, '');
  }
}

/* API Base URL 可以是域名根地址,也可以已经带 /v1。
 * 余额接口路径本身带协议版本,拼接时要避免出现 /v1/v1/...。
 * /api/* 是站点管理路由,即使 Base URL 带 /v1 也应从同一前缀根路径拼接。 */
function routeUrl(base, endpoint) {
  const raw = stripSlash(base);
  const path = String(endpoint || '').startsWith('/') ? String(endpoint) : '/' + String(endpoint || '');
  if (!raw) return path;
  try {
    const u = new URL(raw);
    const pathname = u.pathname.replace(/\/+$/, '');
    const versioned = /\/v1$/i.test(pathname);
    const root = versioned ? pathname.replace(/\/v1$/i, '') : pathname;
    const rootUrl = u.origin + root;
    if (versioned && /^\/v1(?:\/|$)/i.test(path)) {
      return raw + path.slice(3);
    }
    if (versioned && /^\/api(?:\/|$)/i.test(path)) {
      // Base URL 可能本身是 /api/v1,此时不要拼成 /api/api/...。
      return /\/api$/i.test(root) ? rootUrl + path.slice(4) : rootUrl + path;
    }
    return raw + path;
  } catch (e) {
    return raw + path;
  }
}

function sameSiteRedirect(from, to) {
  try {
    const a = new URL(from), b = new URL(to);
    if (a.protocol !== b.protocol && !(a.protocol === 'http:' && b.protocol === 'https:')) return false;
    const ah = a.hostname.toLowerCase(), bh = b.hostname.toLowerCase();
    return ah === bh || ah.endsWith('.' + bh) || bh.endsWith('.' + ah);
  } catch (e) { return false; }
}
function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function iso(d) { return d.toISOString().slice(0, 10); }

/* 从对象里按明确的候选字段名取第一个有限数字。
 * 只认列出的名字,不递归翻找任意字段——递归猜字段会在别的数据上误命中。 */
function pickNum(obj, names) {
  if (!obj || typeof obj !== 'object') return { value: null, field: null };
  for (const n of names) {
    if (typeof obj[n] === 'number' && isFinite(obj[n])) return { value: obj[n], field: n };
  }
  return { value: null, field: null };
}
/* 按点号路径取值,如 'data.balance'。路径写错就返回 null,不猜别的字段。 */
function digField(obj, pathExpr) {
  const parts = String(pathExpr || '').split('.').map((p) => p.trim()).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

// Electron 主进程优先走 Chromium 网络栈：自动跟随系统代理（GNOME manual /
// 环境变量),否则需要代理的专用站点在应用里无法访问。
// useSessionCookies:false 保持与 undici 相同行为，cookie 完全由本模块管理。
let netFetch = null;
try {
  const electron = require('electron');
  if (electron && electron.net && typeof electron.net.fetch === 'function') {
    netFetch = electron.net.fetch.bind(electron.net);
  }
} catch (e) {}

async function http(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || DEFAULT_TIMEOUT);
  try {
    const doFetch = netFetch || fetch;
    const fetchOpts = netFetch ? { ...opts, useSessionCookies: false } : opts;
    const headers = opts.headers || {};
    const hasAuth = Object.keys(headers).some((k) => /^(authorization|x-api-key|x-goog-api-key)$/i.test(k));
    async function request(target, retryRedirect) {
      const res = await doFetch(target, { ...fetchOpts, signal: ctrl.signal });
      const finalUrl = res.url || target;
      // fetch 会在跨域重定向时剥掉 Authorization。官网跳到同站 API 子域是常见部署方式,
      // 只对同站重定向后的最终 URL 重试一次;跨站跳转绝不把 Key 转发过去。
      if (retryRedirect && hasAuth && finalUrl !== target && sameSiteRedirect(target, finalUrl)) {
        return request(finalUrl, false);
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { status: res.status, headers: res.headers, text, json, finalUrl };
    }
    return request(url, true);
  } finally {
    clearTimeout(timer);
  }
}
function jpost(url, body) {
  return http(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
  });
}
function bearer(key, extra) {
  return { authorization: 'Bearer ' + key, 'user-agent': UA, ...(extra || {}) };
}

function authSessionKey(site) {
  return stripSlash(site.baseUrl) + '\n' + String(site.username || '');
}

function setCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (Array.isArray(values) && values.length) return values;
  }
  const raw = headers.get && headers.get('set-cookie');
  if (!raw) return [];
  // undici 的 Headers 在部分版本会把多条 Set-Cookie 合成一行；只在下一个
  // cookie 名开始处切分，不能在 Expires=Wed, ... 的逗号处切开。
  return String(raw).split(/,(?=\s*[^;,\s]+=)/);
}

function mergeSessionCookies(previous, headers) {
  const jar = new Map();
  for (const pair of String(previous || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  for (const line of setCookieValues(headers)) {
    const pair = String(line).split(';')[0];
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value) jar.set(name, value); else jar.delete(name);
  }
  return Array.from(jar, ([name, value]) => name + '=' + value).join('; ');
}

function sessionFromSite(site) {
  return {
    token: site.accessToken || '',
    cookie: site.refreshCookie || '',
    sessionId: site.authSessionId || '',
    expiresAt: Number(site.accessExpiresAt) || 0,
    userId: site.userId ? String(site.userId) : '',
  };
}

function sessionFromBundle(data, headers, previous, site) {
  const d = data || {};
  const old = previous || {};
  const user = d.user || {};
  return {
    token: d.access_token || old.token || '',
    cookie: mergeSessionCookies(old.cookie, headers),
    sessionId: (d.session && d.session.sid) || old.sessionId || '',
    expiresAt: Number(d.access_expires_at) || old.expiresAt || 0,
    userId: site.userId ? String(site.userId) : (user.id ? String(user.id) : old.userId || ''),
  };
}

function sessionHeaders(session, site) {
  const headers = { 'user-agent': UA };
  if (session && session.token) headers.authorization = 'Bearer ' + session.token;
  if (session && session.cookie) headers.cookie = session.cookie;
  const uid = (session && session.userId) || (site && site.userId);
  if (uid) headers['new-api-user'] = String(uid);
  return headers;
}

function rememberAccountSession(site, session) {
  if (!session || (!session.token && !session.cookie)) return;
  ACCOUNT_SESSIONS.set(authSessionKey(site), { ...session });
}

function retryAfterMs(headers) {
  const raw = headers && headers.get && headers.get('retry-after');
  if (!raw) return MIN_LOGIN_COOLDOWN_MS;
  const seconds = Number(raw);
  if (isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_LOGIN_COOLDOWN_MS, Math.max(MIN_LOGIN_COOLDOWN_MS, seconds * 1000));
  }
  const at = Date.parse(raw);
  if (isFinite(at)) return Math.min(MAX_LOGIN_COOLDOWN_MS, Math.max(MIN_LOGIN_COOLDOWN_MS, at - Date.now()));
  return MIN_LOGIN_COOLDOWN_MS;
}

function setLoginCooldown(key, headers) {
  const until = Date.now() + retryAfterMs(headers);
  LOGIN_COOLDOWNS.set(key, until);
  return until;
}

function cooldownError(until, what) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  const subject = what || '登录接口';
  const e = new Error('站点' + subject + '正在冷却限流，请等待 ' + seconds + ' 秒后再试；冷却期间不会再次' + (what ? '请求' : '登录'));
  e.code = 'NEWAPI_LOGIN_COOLDOWN';
  return e;
}

function rateLimitError(key, headers, what) {
  return cooldownError(setLoginCooldown(key, headers), what);
}

function withSession(result, session) {
  // 会话令牌不暴露到结果对象、IPC 快照或调试 JSON。
  if (session && (session.token || session.cookie)) {
    Object.defineProperty(result, '_session', {
      value: { ...session }, enumerable: false, configurable: true,
    });
    // 兼容旧调用方；新代码持久化完整 _session。
    Object.defineProperty(result, '_sessionToken', {
      value: session.token || '', enumerable: false, configurable: true,
    });
  }
  return result;
}

function siteOrigin(base) {
  try { return new URL(base).origin; } catch (e) { return base; }
}

async function refreshNewapiSession(base, site, session, key, retryMismatch = true) {
  const origin = siteOrigin(base);
  const headers = {
    'user-agent': UA,
    origin,
    referer: origin + '/',
  };
  if (session.cookie) headers.cookie = session.cookie;
  if (session.sessionId) headers['x-auth-session'] = session.sessionId;
  const rr = await http(routeUrl(base, '/api/user/auth/refresh'), { method: 'POST', headers });
  const code = rr.json && rr.json.code;

  // 官方前端在 SID 与 Refresh Cookie 不一致时会去掉旧 SID 重试一次。
  if (rr.status === 409 && code === 'AUTH_SESSION_MISMATCH' && session.sessionId && retryMismatch) {
    return refreshNewapiSession(base, site, { ...session, sessionId: '' }, key, false);
  }
  if (rr.status === 429) throw rateLimitError(key, rr.headers);
  if (rr.status === 401) {
    site._clearSession = true;
    const e = new Error('New API 登录会话已失效，请在设置中重新保存账号密码');
    e.code = code || 'AUTH_UNAUTHORIZED';
    throw e;
  }
  if (rr.status !== 200 || !rr.json || !rr.json.success || !rr.json.data || !rr.json.data.access_token) {
    const detail = code || (rr.json && rr.json.error);
    const message = (rr.json && rr.json.message) || '会话刷新失败';
    throw new Error(message + ' (HTTP ' + rr.status + ')' + (detail ? ' [' + detail + ']' : ''));
  }
  return { response: rr, session: sessionFromBundle(rr.json.data, rr.headers, session, site) };
}

/* ============ 协议识别:仅凭 API Base URL,无需任何凭据 ============ */
async function detectFramework(baseUrl) {
  const base = stripSlash(baseUrl);
  const out = { framework: null, quotaPerUnit: null, displayType: null, usdExchangeRate: null, rateLimited: false, tried: [] };
  if (!base) return out;

  // New API:/api/status 是公开端点
  try {
    const s = await http(routeUrl(base, '/api/status'));
    if (s.status === 200 && s.json && s.json.data) {
      out.framework = 'newapi';
      const d = s.json.data;
      if (Number(d.quota_per_unit) > 0) out.quotaPerUnit = Number(d.quota_per_unit);
      if (d.quota_display_type) out.displayType = String(d.quota_display_type);
      if (Number(d.usd_exchange_rate) > 0) out.usdExchangeRate = Number(d.usd_exchange_rate);
      return out;
    }
    if (s.status === 429) {
      out.rateLimited = true;
      out.tried.push('GET /api/status → 429(限流)');
      return out;
    }
    out.tried.push('GET /api/status → ' + s.status);
  } catch (e) { out.tried.push('GET /api/status → ' + e.message); }

  // 某些专用站点:/configs 是公开配置端点,余额走专用账户接口。
  try {
    const c = await http(routeUrl(base, '/configs'));
    if (c.status === 200 && c.json && typeof c.json === 'object'
        && Object.prototype.hasOwnProperty.call(c.json, 'public.balance.price')) {
      out.framework = 'dedicated';
      return out;
    }
    if (c.status === 429) {
      out.rateLimited = true;
      out.tried.push('GET /configs → 429(限流)');
      return out;
    }
    out.tried.push('GET /configs → ' + c.status);
  } catch (e) { out.tried.push('GET /configs → ' + e.message); }

  // Sub2API:GET /v1/usage 不带 Key 时返回 401 且提示 API_KEY_REQUIRED
  try {
    const u = await http(routeUrl(base, '/v1/usage'));
    if ((u.status === 401 || u.status === 403) && /API_KEY_REQUIRED|API key is required/i.test(u.text)) {
      out.framework = 'sub2api';
      return out;
    }
    if (u.status === 429) {
      out.rateLimited = true;
      out.tried.push('GET /v1/usage → 429(限流)');
      return out;
    }
    out.tried.push('GET /v1/usage → ' + u.status);
  } catch (e) { out.tried.push('GET /v1/usage → ' + e.message); }

  // Sub2API 登录端点存在性:参数校验错(400/422)说明路由存在
  try {
    const l = await http(routeUrl(base, '/api/v1/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: '{}',
    });
    if (l.status === 400 || l.status === 422) { out.framework = 'sub2api'; return out; }
    if (l.status === 429) {
      out.rateLimited = true;
      out.tried.push('POST /api/v1/auth/login → 429(限流)');
      return out;
    }
    out.tried.push('POST /api/v1/auth/login → ' + l.status);
  } catch (e) { out.tried.push('POST /api/v1/auth/login → ' + e.message); }

  return out;
}

/* ============ New API 额度换算 ============ */
// 单位标签直接采用站点自己的 quota_display_type。
// 站点没声明这个字段就返回 null,
// 表示"币种未知",由显示层印裸数字,不擅自补 "$"。
function newapiUnitLabel(displayType) {
  if (displayType === 'CNY') return 'CNY';
  if (displayType === 'TOKENS') return 'TOKENS';
  if (displayType === 'USD') return 'USD';
  return null;
}
// 按协议约定换算额度,避免把总额度直接显示成余额。
function newapiQuotaToDisplay(q, meta) {
  if (meta.displayType === 'TOKENS') return q;
  if (meta.displayType === 'CNY') return q / meta.quotaPerUnit * meta.usdExchangeRate;
  return q / meta.quotaPerUnit;
}
// 取值优先级:站点自定义 quotaPerUnit > 站点 /api/status > New API 默认值
// 币种显示优先级:用户填的 balanceUnit > 站点 quota_display_type > 未知(裸数字)
function newapiMeta(det, site) {
  const s = site || {};
  const per = Number(s.quotaPerUnit) > 0 ? Number(s.quotaPerUnit)
    : (det && det.quotaPerUnit) ? det.quotaPerUnit
      : NEWAPI_QUOTA_PER_UNIT;
  const displayType = (det && det.displayType) || null;
  const rate = det && det.usdExchangeRate > 0 ? det.usdExchangeRate : 1;
  const userUnit = String(s.balanceUnit || '').trim();
  return {
    quotaPerUnit: per, displayType, usdExchangeRate: rate,
    unit: userUnit || newapiUnitLabel(displayType),
    currencyDeclared: !!(det && det.displayType),
  };
}

/* ============ 方式一:API Key 直查 ============ */
async function sub2apiByKey(base, key, site) {
  // /v1/usage 同时返回 balance 与 remaining(同值),都是账户级钱包真实剩余余额
  const r = await http(routeUrl(base, '/v1/usage'), { headers: bearer(key) });
  if (r.status === 200 && r.json && (typeof r.json.balance === 'number' || typeof r.json.remaining === 'number')) {
    const j = r.json;
    const bal = numOrNull(j.balance) != null ? j.balance : j.remaining;
    const userUnit = String((site && site.balanceUnit) || '').trim();
    return {
      framework: 'sub2api', name: site.name || base,
      balance: bal, unit: userUnit || j.unit || 'USD',
      todayCost: j.usage && j.usage.today ? numOrNull(j.usage.today.actual_cost) : null,
      totalCost: j.usage && j.usage.total ? numOrNull(j.usage.total.actual_cost) : null,
      planName: j.planName || null, mode: j.mode || null,
    };
  }
  throw new Error('Sub2API /v1/usage 未返回余额(HTTP ' + r.status + ')');
}

async function newapiByKey(base, key, site, det) {
  const sub = await http(routeUrl(base, '/v1/dashboard/billing/subscription'), { headers: bearer(key) });
  if (sub.status !== 200 || !sub.json || typeof sub.json.hard_limit_usd !== 'number') {
    throw new Error('New API 计费接口未开放该 Key(HTTP ' + sub.status + '),需改用账号密码');
  }
  let used = null;
  try {
    const end = new Date();
    const start = new Date(Date.now() - 90 * 864e5);
    const u = await http(routeUrl(base, '/v1/dashboard/billing/usage?start_date=' + iso(start) + '&end_date=' + iso(end)), { headers: bearer(key) });
    if (u.json && typeof u.json.total_usage === 'number') used = u.json.total_usage / 100;
  } catch (e) {}

  const meta = newapiMeta(det, site);
  // hard_limit_usd 是总额度而非剩余余额。
  const granted = sub.json.hard_limit_usd;
  // 无限额度哨兵值与真实余额无关。
  const unlimited = granted === NEWAPI_UNLIMITED_SENTINEL;
  // 已用拿不到时不做减法,避免把总额度误当余额显示
  const balance = (unlimited || used == null) ? null : granted - used;
  return {
    framework: 'newapi', name: site.name || base,
    balance, unit: meta.unit, limit: granted, totalCost: used,
    unlimited,
    unlimitedHint: unlimited ? '该 Key 为无限额度,站点不提供可显示的数字余额' : null,
  };
}

async function fetchByApiKey(site) {
  // 手填接口路径优先于一切识别,失败也不回退
  if (String(site.balancePath || '').trim()) return customBalanceQuery(site);
  const configuredFw = frameworkFromType(site);
  // 显式选择的能力探测/自定义接口直接执行,不再跑协议识别
  if (configuredFw === 'custom') return customBalanceQuery(site);
  if (configuredFw === 'probe') return probeByKey(site);
  const base = stripSlash(site.baseUrl);
  const det = await detectFramework(base);
  if (det.rateLimited) throw rateLimitError(authSessionKey(site), null, '的余额接口');
  if (det.framework === 'sub2api') return sub2apiByKey(base, site.apiKey, site);
  if (det.framework === 'newapi') return newapiByKey(base, site.apiKey, site, det);
  // 识别不出协议:能力探测兜底,依次试已知余额接口,谁返回合法余额用谁
  return probeByKey(site);
}

/* ============ 方式二:账号密码(纯 HTTP,不启动浏览器) ============ */
// Sub2API: POST /api/v1/auth/login -> JWT;GET /api/v1/auth/me -> balance
async function sub2apiLogin(site) {
  const base = stripSlash(site.baseUrl);
  const r = await jpost(routeUrl(base, '/api/v1/auth/login'), { email: site.email || site.username, password: site.password });
  if (!r.json || r.json.code !== 0 || !r.json.data) throw new Error((r.json && r.json.message) || 'login failed (HTTP ' + r.status + ')');
  const token = r.json.data.access_token;
  const user = r.json.data.user || {};
  let balance = numOrNull(user.balance);
  let todayCost = null, totalCost = null, name = user.email || site.email;
  const me = await http(routeUrl(base, '/api/v1/auth/me'), { headers: { authorization: 'Bearer ' + token } });
  if (me.json && me.json.code === 0 && me.json.data) {
    if (numOrNull(me.json.data.balance) != null) balance = me.json.data.balance;
    if (me.json.data.email) name = me.json.data.email;
  }
  const st = await http(routeUrl(base, '/api/v1/usage/dashboard/stats'), { headers: { authorization: 'Bearer ' + token } });
  if (st.json && st.json.code === 0 && st.json.data) {
    todayCost = numOrNull(st.json.data.today_actual_cost);
    totalCost = numOrNull(st.json.data.total_actual_cost);
  }
  return {
    framework: 'sub2api', name, balance, unit: String(site.balanceUnit || '').trim() || 'USD', todayCost, totalCost,
  };
}

function normalizeNewapiUser(d, site, meta, nameHint) {
  if (!d || typeof d.quota !== 'number' || !isFinite(d.quota)) {
    throw new Error('New API 用户接口未返回有效 quota');
  }
  return {
    framework: 'newapi', name: d.display_name || d.username || nameHint || site.username || site.baseUrl,
    balance: newapiQuotaToDisplay(d.quota || 0, meta), unit: meta.unit,
    used: newapiQuotaToDisplay(d.used_quota || 0, meta),
    totalCost: newapiQuotaToDisplay(d.used_quota || 0, meta),
    requestCount: d.request_count || 0,
  };
}

async function newapiLogin(site, det, options) {
  const key = authSessionKey(site);
  const running = AUTH_INFLIGHT.get(key);
  if (running) return running;
  const promise = newapiLoginOnce(site, det, options || {});
  AUTH_INFLIGHT.set(key, promise);
  try {
    return await promise;
  } finally {
    if (AUTH_INFLIGHT.get(key) === promise) AUTH_INFLIGHT.delete(key);
  }
}

async function newapiLoginOnce(site, det, options) {
  const base = stripSlash(site.baseUrl);
  const key = authSessionKey(site);
  const allowLogin = options.allowLogin !== false;
  const cooldownUntil = LOGIN_COOLDOWNS.get(key) || 0;
  if (cooldownUntil > Date.now()) throw cooldownError(cooldownUntil);
  if (cooldownUntil) LOGIN_COOLDOWNS.delete(key);
  const detected = det || (await detectFramework(base));
  if (detected.rateLimited) throw rateLimitError(key, null);
  const meta = newapiMeta(detected, site);

  // 一个站点每轮只走一条会话链。内存中的会话可能含本轮旋转后的
  // Refresh Cookie；没有内存会话时才使用磁盘持久化值。
  const persisted = sessionFromSite(site);
  const cached = ACCOUNT_SESSIONS.get(key);
  let session = cached && (cached.token || cached.cookie) ? { ...cached } : persisted;

  if (session.token || session.cookie) {
    if (session.token) {
      const sr = await http(routeUrl(base, '/api/user/self'), { headers: sessionHeaders(session, site) });
      if (sr.status === 429) throw rateLimitError(key, sr.headers);
      if (sr.status === 200 && sr.json && sr.json.success) {
        const d = sr.json.data || {};
        const user = d.user && typeof d.user.quota === 'number' ? d.user : d;
        if (user && typeof user.quota === 'number') {
          rememberAccountSession(site, session);
          return withSession(normalizeNewapiUser(user, site, meta, user.username), session);
        }
        throw new Error('New API 用户接口未返回有效余额');
      }
      // 429、服务器错误和网络/权限策略错误都保留会话，更不能降级成登录。
      if (sr.status !== 401 && sr.status !== 403) {
        const message = (sr.json && sr.json.message) || 'New API 会话读取失败';
        throw new Error(message + ' (HTTP ' + sr.status + ')');
      }
    }

    // 短期 Access Token 失效后，仅使用官方 Refresh Cookie 续期。刷新成功
    // 会旋转 Cookie 和 SID；刷新失败不会偷偷创建新的登录会话。
    if (session.cookie) {
      const refreshed = await refreshNewapiSession(base, site, session, key);
      session = refreshed.session;
      rememberAccountSession(site, session);
      const rd = refreshed.response.json.data || {};
      if (rd.user && typeof rd.user.quota === 'number') {
        return withSession(normalizeNewapiUser(rd.user, site, meta, rd.user.username), session);
      }
      const sr = await http(routeUrl(base, '/api/user/self'), { headers: sessionHeaders(session, site) });
      if (sr.status === 429) throw rateLimitError(key, sr.headers);
      if (sr.status !== 200 || !sr.json || !sr.json.success) {
        const message = (sr.json && sr.json.message) || 'New API 刷新会话后读取余额失败';
        throw new Error(message + ' (HTTP ' + sr.status + ')');
      }
      const d = sr.json.data || {};
      const user = d.user && typeof d.user.quota === 'number' ? d.user : d;
      return withSession(normalizeNewapiUser(user, site, meta, user.username), session);
    }

    // 旧版 TokenBuddy 只保存了短期 Access Token。只有用户明确手动刷新
    // 或保存设置时，才允许在确认 401/403 后登录一次，迁移到完整会话。
    if (!allowLogin) {
      throw new Error('登录会话已过期，请打开设置并保存一次以重新登录');
    }
  }

  if (!allowLogin) {
    throw new Error('New API 没有可用会话，定时刷新不会自动登录；请手动点击刷新');
  }

  if (!site.username || !site.password) {
    throw new Error('New API 会话已失效，请重新填写账号密码');
  }

  const origin = siteOrigin(base);
  const lr = await http(routeUrl(base, '/api/user/login?turnstile='), {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'user-agent': UA,
      origin, referer: origin + '/',
    },
    body: JSON.stringify({ username: site.username, password: site.password }),
  });
  if (!lr.json || !lr.json.success) {
    if (lr.status === 429) throw rateLimitError(key, lr.headers);
    const detail = lr.json && (lr.json.code || lr.json.error);
    const message = (lr.json && lr.json.message) || 'login failed';
    if (lr.status === 409 && detail === 'AUTH_SESSION_LIMIT') {
      const e = new Error('登录会话数量已达站点上限，请先在网站退出其他设备后再手动刷新');
      e.code = detail;
      throw e;
    }
    const data = lr.json && lr.json.data;
    if ((data && (data.require_2fa || data.requires_2fa)) || detail === 'TWO_FACTOR_REQUIRED') {
      const e = new Error('该账号启用了两步验证，请先在网站完成登录；TokenBuddy 暂不代填验证码');
      e.code = detail || 'TWO_FACTOR_REQUIRED';
      throw e;
    }
    throw new Error(message + ' (HTTP ' + lr.status + ')' + (detail ? ' [' + detail + ']' : ''));
  }
  LOGIN_COOLDOWNS.delete(key);
  const d = lr.json.data || {};
  session = sessionFromBundle(d, lr.headers, {}, site);
  if (!session.token) throw new Error('登录成功但站点未返回 Access Token');
  rememberAccountSession(site, session);
  // 新版 New API:登录响应里已带完整 user 对象(含 quota / used_quota),无需再请求 /api/user/self
  if (d.user && typeof d.user.quota === 'number') {
    return withSession(normalizeNewapiUser(d.user, site, meta, d.user.username), session);
  }
  // 旧版 New API:只有 Set-Cookie,需带 cookie + New-Api-User 再查 /api/user/self
  const sr = await http(routeUrl(base, '/api/user/self'), { headers: sessionHeaders(session, site) });
  if (!sr.json || !sr.json.success) throw new Error((sr.json && sr.json.message) || 'self failed (HTTP ' + sr.status + ')');
  return withSession(normalizeNewapiUser(sr.json.data || {}, site, meta), session);
}

/* ============ 专用站点账户适配 ============ */
function normalizeDedicatedUser(user, site) {
  if (!user || typeof user.balance !== 'number' || !isFinite(user.balance)) {
    throw new Error('专用站点账户接口未返回有效 balance');
  }
  return {
    framework: 'dedicated',
    name: user.username || user.email || site.username || site.baseUrl,
    balance: user.balance,
    unit: String(site.balanceUnit || '').trim() || 'USD',
  };
}

async function dedicatedLogin(site, options) {
  const key = authSessionKey(site);
  const running = AUTH_INFLIGHT.get(key);
  if (running) return running;
  const promise = dedicatedLoginOnce(site, options || {});
  AUTH_INFLIGHT.set(key, promise);
  try {
    return await promise;
  } finally {
    if (AUTH_INFLIGHT.get(key) === promise) AUTH_INFLIGHT.delete(key);
  }
}

async function dedicatedLoginOnce(site, options) {
  const base = stripSlash(site.baseUrl);
  const key = authSessionKey(site);
  const allowLogin = options.allowLogin !== false;
  const cooldownUntil = LOGIN_COOLDOWNS.get(key) || 0;
  if (cooldownUntil > Date.now()) throw cooldownError(cooldownUntil);
  if (cooldownUntil) LOGIN_COOLDOWNS.delete(key);

  const persisted = sessionFromSite(site);
  const cached = ACCOUNT_SESSIONS.get(key);
  let session = cached && cached.token ? { ...cached } : persisted;
  if (session.token) {
    const me = await http(routeUrl(base, '/auth/me'), { headers: bearer(session.token) });
    if (me.status === 429) throw rateLimitError(key, me.headers);
    if (me.status === 200 && me.json) {
      rememberAccountSession(site, session);
      return withSession(normalizeDedicatedUser(me.json, site), session);
    }
    if (me.status !== 401 && me.status !== 403) {
      const message = (me.json && me.json.message) || '专用站点会话读取失败';
      throw new Error(message + ' (HTTP ' + me.status + ')');
    }
    site._clearSession = true;
    ACCOUNT_SESSIONS.delete(key);
    session = sessionFromSite({});
    if (!allowLogin) throw new Error('专用站点登录会话已过期，请打开设置并保存一次以重新登录');
  }

  if (!allowLogin) {
    throw new Error('专用站点没有可用会话，定时刷新不会自动登录；请在设置中保存一次');
  }
  if (!site.username || !site.password) throw new Error('该专用站点需要填写账号和密码');

  const origin = siteOrigin(base);
  const lr = await http(routeUrl(base, '/auth/login'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'user-agent': UA,
      origin, referer: origin + '/login',
    },
    body: JSON.stringify({ username: site.username, password: site.password }),
  });
  if (lr.status === 429) throw rateLimitError(key, lr.headers);
  if (lr.status !== 200 || !lr.json) {
    const message = (lr.json && lr.json.message) || '专用站点登录失败';
    throw new Error(message + ' (HTTP ' + lr.status + ')');
  }
  if (lr.json.otp_required && !(lr.json.user_token || lr.json.userToken)) {
    const e = new Error('该专用站点账号启用了两步验证，请先在网站完成登录');
    e.code = 'TWO_FACTOR_REQUIRED';
    throw e;
  }
  const token = lr.json.user_token || lr.json.userToken;
  if (!token) throw new Error('专用站点登录成功但未返回 user_token');
  LOGIN_COOLDOWNS.delete(key);
  session = { token, cookie: '', sessionId: '', expiresAt: 0, userId: lr.json.id ? String(lr.json.id) : '' };
  rememberAccountSession(site, session);
  if (typeof lr.json.balance === 'number') {
    return withSession(normalizeDedicatedUser(lr.json, site), session);
  }
  const me = await http(routeUrl(base, '/auth/me'), { headers: bearer(token) });
  if (me.status !== 200 || !me.json) throw new Error('专用站点登录后读取余额失败 (HTTP ' + me.status + ')');
  return withSession(normalizeDedicatedUser(me.json, site), session);
}

/* ============ 手填接口路径(用户显式配置,优先于一切识别) ============
 * 只要 site.balancePath 非空,它就是唯一权威路径:不识别协议、不做能力探测。
 * 失败时如实报错(状态码 + 响应摘要),不静默回退到识别或探测——
 * 用户显式配置的接口失败了就该看见失败,不能偷偷换个接口把结果改写掉。
 * 路径里写 {{key}} 会被替换成 API Key,用来覆盖 Bearer 之外的鉴权位置。 */
async function customBalanceQuery(site) {
  const base = stripSlash(site.baseUrl);
  let path = String(site.balancePath || '').trim();
  if (!path) throw new Error('未填写余额接口路径');
  if (!path.startsWith('/')) path = '/' + path;
  const apiKey = site.apiKey || '';
  if (path.includes('{{key}}')) path = path.split('{{key}}').join(encodeURIComponent(apiKey));

  const headers = { 'user-agent': UA };
  const auth = String(site.balanceAuth || 'bearer').toLowerCase();
  if (auth === 'bearer' && apiKey) headers.authorization = 'Bearer ' + apiKey;
  if (auth === 'url_key' && apiKey) {
    path += (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(apiKey);
  }

  const r = await http(routeUrl(base, path), { headers });
  if (r.status === 429) throw rateLimitError(authSessionKey(site), r.headers, '的余额接口');
  if (r.status !== 200 || !r.json || typeof r.json !== 'object') {
    // 只截取诊断用的响应前 200 字(错误页可能是整页 HTML);
    // HTTP 状态码是完整保留的,判断依据不缺。余额结果本身从不截断。
    const snippet = String(r.text || '').slice(0, 200);
    throw new Error('自定义余额接口查询失败 (HTTP ' + r.status + ')'
      + (snippet ? ',响应前 200 字:' + snippet : ',响应体为空'));
  }

  // 字段路径留空时只认顶层的三个明确名字,不递归翻找
  const fieldPath = String(site.balanceField || '').trim();
  let raw = null, usedField = null;
  if (fieldPath) {
    raw = digField(r.json, fieldPath);
    usedField = fieldPath;
    if (typeof raw !== 'number' || !isFinite(raw)) {
      throw new Error('自定义余额字段「' + fieldPath + '」不是数字,实际拿到:' + JSON.stringify(raw));
    }
  } else {
    const hit = pickNum(r.json, ['balance', 'remaining', 'quota']);
    if (hit.value == null) {
      throw new Error('自定义余额接口未在顶层返回 balance/remaining/quota,实际拿到:' + Object.keys(r.json).join(', '));
    }
    raw = hit.value; usedField = hit.field;
  }

  // 币种:优先用户填的,其次站点响应里的明确字段,都没有就不印符号(不擅自假定 USD)
  let unit = String(site.balanceUnit || '').trim() || null;
  if (!unit) {
    for (const n of ['unit', 'currency']) {
      const v = r.json[n];
      if (typeof v === 'string' && v.trim()) { unit = v.trim(); break; }
    }
  }
  return {
    framework: 'custom', name: site.name || base,
    balance: raw, unit,
    customField: usedField,
  };
}

/* ============ 能力探测:识别不出协议时,拿 API Key 依次试探余额接口 ============
 * 只在协议探测全部落空时启用。命中即停,并把命中协议写回 site.probeProtocol,
 * 后续刷新直接走该协议,不再重复试探。每一步都严格校验响应形状,校验不过就试
 * 下一个;全部落空时如实列出各步的真实 HTTP 状态,不做兜底伪造。
 * 命中结果一律标成 framework: 'probe' + probeProtocol/probeField,界面上明确
 * 显示是"探测命中",不冒充成 Sub2API / New API。 */
const BALANCE_PROBES = [
  {
    id: 'usage', path: '/v1/usage', label: '/v1/usage',
    parse: (j) => {
      const b = pickNum(j, ['balance', 'remaining']);
      return b.value == null ? null : {
        balance: b.value, field: b.field,
        todayCost: j.usage && j.usage.today ? numOrNull(j.usage.today.actual_cost) : null,
        totalCost: j.usage && j.usage.total ? numOrNull(j.usage.total.actual_cost) : null,
        unit: typeof j.unit === 'string' ? j.unit : null,
        name: j.planName || null,
      };
    },
  },
  {
    // 注意:hard_limit_usd 是"总额度"不是余额(New API controller/billing.go),
    // 所以还要再取一次已用才能相减;无限额度哨兵值同样不能当余额。
    id: 'billing', path: '/v1/dashboard/billing/subscription', label: '/v1/dashboard/billing/*',
    parse: (j) => {
      const g = pickNum(j, ['hard_limit_usd']);
      return g.value == null ? null : { balance: null, field: 'hard_limit_usd(总额度)', limit: g.value, _needsUsage: true };
    },
  },
  {
    id: 'authme', path: '/api/v1/auth/me', label: '/api/v1/auth/me',
    parse: (j) => {
      const b = pickNum(j && j.data, ['balance']);
      return b.value == null ? null : { balance: b.value, field: 'data.' + b.field, unit: null, name: (j.data && (j.data.email || j.data.username)) || null };
    },
  },
  {
    // New API 的 /api/usage/token 路由(router/api-router.go 的 usageRoute/tokenUsageRoute)。
    // 字段随部署而异,所以只认明确的余额类字段名,认不出就换下一个候选。
    id: 'tokenusage', path: '/api/usage/token/', label: '/api/usage/token/',
    parse: (j) => {
      const src = (j && j.data && typeof j.data === 'object') ? j.data : j;
      const b = pickNum(src, ['balance', 'remaining', 'quota']);
      return b.value == null ? null : { balance: b.value, field: b.field, unit: null, name: null };
    },
  },
  {
    id: 'userself', path: '/api/user/self', label: '/api/user/self',
    parse: (j) => {
      const b = pickNum(j && j.data, ['quota', 'balance']);
      return b.value == null ? null : { balance: b.value, field: 'data.' + b.field, unit: null, name: (j.data && (j.data.display_name || j.data.username)) || null };
    },
  },
];

function probeByKey(site) {
  const base = stripSlash(site.baseUrl);
  const key = site.apiKey;
  if (!key) throw new Error('能力探测需要 API Key');
  // 记住的协议排在最前面试;它读不到就把全部候选按原顺序再过一遍(不重复请求同一个)
  const known = String(site.probeProtocol || '');
  const knownProbe = known ? BALANCE_PROBES.find((p) => p.id === known) : null;
  const list = knownProbe
    ? [knownProbe, ...BALANCE_PROBES.filter((p) => p.id !== knownProbe.id)]
    : BALANCE_PROBES;
  return runProbes(base, key, site, list);
}

async function runProbes(base, key, site, list) {
  const attempts = [];
  for (const p of list) {
    let r;
    try {
      r = await http(routeUrl(base, p.path), { headers: bearer(key) });
    } catch (e) {
      attempts.push(p.label + ' → ' + e.message);
      continue;
    }
    if (r.status === 429) throw rateLimitError(authSessionKey(site), r.headers, '的余额接口');
    if (r.status !== 200 || !r.json) {
      attempts.push(p.label + ' → HTTP ' + r.status);
      continue;
    }
    let got = null;
    try { got = p.parse(r.json); } catch (e) { got = null; }
    if (!got) {
      attempts.push(p.label + ' → 200 但响应里没有可识别的余额字段');
      continue;
    }
    site.probeProtocol = p.id;
    const out = {
      framework: 'probe', probeProtocol: p.id, probeField: got.field, probeLabel: p.label,
      name: got.name || site.name || base,
      balance: got.balance, unit: got.unit || null,
      todayCost: got.todayCost != null ? got.todayCost : null,
      totalCost: got.totalCost != null ? got.totalCost : null,
    };
    if (got._needsUsage) {
      // 总额度要减已用才是余额;无限额度哨兵值直接判为"无可显示数字余额"
      const unlimited = got.limit === NEWAPI_UNLIMITED_SENTINEL;
      out.limit = got.limit;
      out.unlimited = unlimited;
      let used = null;
      try {
        const end = new Date();
        const start = new Date(Date.now() - 90 * 864e5);
        const u = await http(routeUrl(base, '/v1/dashboard/billing/usage?start_date=' + iso(start) + '&end_date=' + iso(end)), { headers: bearer(key) });
        if (u.json && typeof u.json.total_usage === 'number') used = u.json.total_usage / 100;
      } catch (e) {}
      out.totalCost = used;
      out.balance = (unlimited || used == null) ? null : got.limit - used;
      out.unlimitedHint = unlimited ? '该 Key 为无限额度,站点不提供可显示的数字余额' : null;
      if (!unlimited && used == null) {
        out.probeNote = '已拿到总额度 ' + got.limit + ',但已用额度查不到,不做减法(避免把总额度当余额)';
      }
    }
    return out;
  }
  throw new Error('能力探测未能从任何已知接口读到余额。真实结果:\n' + attempts.join('\n'));
}

/* ============ 统一入口 ============ */
// 协议探测失败时,按用户填的类型兜底
function frameworkFromType(site) {
  const t = String(site.type || '').toLowerCase();
  if (t === 'sub2api' || t === 'sub2') return 'sub2api';
  if (t === 'newapi' || t === 'new-api' || t === 'oneapi' || t === 'one-api') return 'newapi';
  if (t === 'dedicated') return 'dedicated';
  if (t === 'probe' || t.startsWith('probe:')) return 'probe';
  // 'custom' 只在真的填了手填路径时才成立;路径被清空就该回到正常识别
  if (t === 'custom' && String(site.balancePath || '').trim()) return 'custom';
  if (site.email) return 'sub2api';
  return null;
}

async function fetchBalance(site, options) {
  if (!site || !site.baseUrl) throw new Error('缺少 API Base URL');
  // 手填接口路径是用户显式配置,优先于一切识别,失败也不回退
  if (String(site.balancePath || '').trim()) return customBalanceQuery(site);
  const configuredFw = frameworkFromType(site);
  // 手填接口与能力探测都是显式选择:直接执行,不再跑协议识别。
  // 能力探测记住协议后走这里,兑现「之后不再重复试探」。
  if (configuredFw === 'custom') return customBalanceQuery(site);
  if (configuredFw === 'probe') {
    if (!site.apiKey) throw new Error('能力探测需要 API Key');
    return probeByKey(site);
  }
  const base = stripSlash(site.baseUrl);
  // 已有登录会话只能是 New API 的后台会话;冷却期间不要先做公开探测,
  // 否则一次刷新仍会访问限流中的站点。newapiLogin 会在冷却结束后再补探测。
  const sessionSite = !!(site.accessToken || site.refreshCookie) && configuredFw !== 'sub2api';
  const det = sessionSite && configuredFw ? null : await detectFramework(base);
  if (det && det.rateLimited) throw rateLimitError(authSessionKey(site), null, '的余额接口');
  const fw = (det && det.framework) || configuredFw || (sessionSite ? 'newapi' : null);
  const hasCreds = !!(site.username && site.password);

  if (fw === 'probe') {
    if (!site.apiKey) throw new Error('能力探测需要 API Key');
    return probeByKey(site);
  }
  if (fw === 'sub2api') {
    // Sub2API 的 Key 直查返回的就是账户钱包真实余额,优于登录态,所以优先用 Key
    if (site.apiKey) return sub2apiByKey(base, site.apiKey, site);
    return sub2apiLogin(site);
  }
  if (fw === 'newapi') {
    // 登录会话返回账户真实余额。New API 的 API Key 可能只返回无限额度
    // 占位值，不能覆盖账号余额；仅在完全没有账号和会话时才使用 Key。
    if (sessionSite || hasCreds) return newapiLogin(site, det, options || {});
    if (site.apiKey) return newapiByKey(base, site.apiKey, site, det);
    return newapiLogin(site, det, options || {});
  }
  if (fw === 'dedicated') return dedicatedLogin(site, options || {});
  // 识别不出协议:能力探测兜底。全部落空时的错误会列出每个接口的真实结果。
  return probeByKey(site);
}

module.exports = {
  fetchBalance, fetchByApiKey, sub2apiLogin, newapiLogin, dedicatedLogin, detectFramework,
  sub2apiByKey, newapiByKey, newapiQuotaToDisplay, NEWAPI_QUOTA_PER_UNIT, NEWAPI_UNLIMITED_SENTINEL,
  customBalanceQuery, probeByKey, frameworkFromType, BALANCE_PROBES,
  clearNewapiSessions: () => {
    ACCOUNT_SESSIONS.clear(); LOGIN_COOLDOWNS.clear(); AUTH_INFLIGHT.clear();
  },
};
