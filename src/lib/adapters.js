'use strict';

/*
 * 余额适配器。目标:适配绝大多数中转站。
 * 主流中转站基本是两套架构:
 *   - Sub2API   : GET /v1/usage                                  (API Key 直查余额)
 *   - New API / One API : GET /v1/dashboard/billing/subscription  (API Key 直查额度)
 *                         GET /v1/dashboard/billing/usage          (API Key 查已用,单位:分)
 * 因此"只填站点地址 + API Key"即可,程序自动识别是哪套。
 * 另外保留账号密码登录作为兜底(个别站点不开放 Key 查余额)。
 */

const DEFAULT_TIMEOUT = 15000;
const NEWAPI_QUOTA_PER_UNIT = 500000; // New API: 500000 = $1

function stripSlash(u) { return String(u || '').replace(/\/+$/, ''); }
function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function iso(d) { return d.toISOString().slice(0, 10); }

async function http(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, headers: res.headers, text, json };
  } finally {
    clearTimeout(timer);
  }
}
function jpost(url, body) {
  return http(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'TokenBuddyTray/0.1' },
    body: JSON.stringify(body),
  });
}
function bearer(key, extra) {
  return { authorization: 'Bearer ' + key, 'user-agent': 'TokenBuddyTray/0.1', ...(extra || {}) };
}

/* ============ 方式一:API Key 直查(自动识别) ============ */
async function fetchByApiKey(site) {
  const base = stripSlash(site.baseUrl);
  const key = site.apiKey;
  const tried = [];

  // 1) Sub2API
  try {
    const r = await http(base + '/v1/usage', { headers: bearer(key) });
    if (r.status === 200 && r.json && (typeof r.json.balance === 'number' || typeof r.json.remaining === 'number')) {
      const j = r.json;
      const bal = numOrNull(j.balance) != null ? j.balance : j.remaining;
      return {
        framework: 'sub2api', name: site.name || base,
        balance: bal, unit: j.unit || 'USD',
        todayCost: j.usage && j.usage.today ? numOrNull(j.usage.today.actual_cost) : null,
        totalCost: j.usage && j.usage.total ? numOrNull(j.usage.total.actual_cost) : null,
        planName: j.planName || null, mode: j.mode || null,
      };
    }
    tried.push('Sub2API /v1/usage → ' + r.status);
  } catch (e) { tried.push('Sub2API /v1/usage → ' + e.message); }

  // 2) New API / One API
  try {
    const sub = await http(base + '/v1/dashboard/billing/subscription', { headers: bearer(key) });
    if (sub.status === 200 && sub.json && typeof sub.json.hard_limit_usd === 'number') {
      let used = null;
      try {
        const end = new Date();
        const start = new Date(Date.now() - 90 * 864e5);
        const u = await http(base + '/v1/dashboard/billing/usage?start_date=' + iso(start) + '&end_date=' + iso(end), { headers: bearer(key) });
        if (u.json && typeof u.json.total_usage === 'number') used = u.json.total_usage / 100;
      } catch (e) {}
      return {
        framework: 'newapi', name: site.name || base,
        balance: sub.json.hard_limit_usd, unit: 'USD', limit: sub.json.hard_limit_usd,
        todayCost: null, totalCost: used,
      };
    }
    if (sub.status === 401 || sub.status === 403) tried.push('New API Key 查余额未开放 → ' + sub.status);
    else tried.push('New API billing → ' + sub.status);
  } catch (e) { tried.push('New API billing → ' + e.message); }

  throw new Error('未能识别该站点的余额接口(可改用账号密码)。已尝试:' + tried.join(' | '));
}

/* ============ 方式二:账号密码(兜底) ============ */
// Sub2API: POST /api/v1/auth/login -> JWT;GET /api/v1/auth/me -> balance
async function sub2apiLogin(site) {
  const base = stripSlash(site.baseUrl);
  const r = await jpost(base + '/api/v1/auth/login', { email: site.email || site.username, password: site.password });
  if (!r.json || r.json.code !== 0 || !r.json.data) throw new Error((r.json && r.json.message) || 'login failed (HTTP ' + r.status + ')');
  const token = r.json.data.access_token;
  const user = r.json.data.user || {};
  let balance = numOrNull(user.balance);
  let todayCost = null, totalCost = null, name = user.email || site.email;
  const me = await http(base + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + token } });
  if (me.json && me.json.code === 0 && me.json.data) {
    if (numOrNull(me.json.data.balance) != null) balance = me.json.data.balance;
    if (me.json.data.email) name = me.json.data.email;
  }
  const st = await http(base + '/api/v1/usage/dashboard/stats', { headers: { authorization: 'Bearer ' + token } });
  if (st.json && st.json.code === 0 && st.json.data) {
    todayCost = numOrNull(st.json.data.today_actual_cost);
    totalCost = numOrNull(st.json.data.total_actual_cost);
  }
  return { framework: 'sub2api', name, balance, unit: 'USD', todayCost, totalCost };
}

// New API: POST /api/user/login -> Set-Cookie;GET /api/user/self + New-Api-User -> quota
function normalizeNewapiUser(d, site) {
  const per = Number(site.quotaPerUnit) > 0 ? Number(site.quotaPerUnit) : NEWAPI_QUOTA_PER_UNIT;
  return {
    framework: 'newapi', name: d.display_name || d.username || site.username || site.baseUrl,
    balance: (d.quota || 0) / per, unit: 'USD', used: (d.used_quota || 0) / per,
    totalCost: (d.used_quota || 0) / per, requestCount: d.request_count || 0,
  };
}
async function newapiLogin(site) {
  const base = stripSlash(site.baseUrl);
  let uid = site.userId ? String(site.userId) : '';
  const lr = await jpost(base + '/api/user/login', { username: site.username, password: site.password });
  if (!lr.json || !lr.json.success) throw new Error((lr.json && lr.json.message) || 'login failed (HTTP ' + lr.status + ')');
  if (lr.json.data && lr.json.data.id && !uid) uid = String(lr.json.data.id);
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  const sr = await http(base + '/api/user/self', { headers: { cookie, 'new-api-user': uid, 'user-agent': 'TokenBuddyTray/0.1' } });
  if (!sr.json || !sr.json.success) throw new Error((sr.json && sr.json.message) || 'self failed (HTTP ' + sr.status + ')');
  return normalizeNewapiUser(sr.json.data || {}, site);
}

/* ============ 统一入口 ============ */
async function fetchBalance(site) {
  if (!site || !site.baseUrl) throw new Error('缺少站点地址');
  if (site.apiKey) return fetchByApiKey(site);
  const type = (site.type || '').toLowerCase();
  if (type === 'newapi' || type === 'new-api' || type === 'oneapi' || type === 'one-api') return newapiLogin(site);
  if (type === 'sub2api') return sub2apiLogin(site);
  if (site.email) return sub2apiLogin(site);
  return newapiLogin(site);
}

module.exports = { fetchBalance, fetchByApiKey, sub2apiLogin, newapiLogin };
