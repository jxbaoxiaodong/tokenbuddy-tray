'use strict';

const DEFAULT_TIMEOUT = 15000;
const NEWAPI_QUOTA_PER_UNIT = 500000; // New API 默认 500000 = $1

function stripSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

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

/* ------------------------- Sub2API ------------------------- */
// 登录: POST /api/v1/auth/login {email,password} -> data.access_token / data.user.balance
// 余额: GET  /api/v1/auth/me (Bearer)            -> data.balance
// 消费: GET  /api/v1/usage/dashboard/stats       -> today_actual_cost / total_actual_cost
async function sub2apiBalance(site) {
  const base = stripSlash(site.baseUrl);
  const r = await jpost(base + '/api/v1/auth/login', { email: site.email, password: site.password });
  if (!r.json || r.json.code !== 0 || !r.json.data) {
    throw new Error(r.json && r.json.message ? r.json.message : 'login failed (HTTP ' + r.status + ')');
  }
  const token = r.json.data.access_token;
  const user = r.json.data.user || {};
  let balance = typeof user.balance === 'number' ? user.balance : null;
  let todayCost = null, totalCost = null, name = user.email || site.email;

  const me = await http(base + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + token } });
  if (me.json && me.json.code === 0 && me.json.data) {
    if (typeof me.json.data.balance === 'number') balance = me.json.data.balance;
    if (me.json.data.email) name = me.json.data.email;
  }
  const st = await http(base + '/api/v1/usage/dashboard/stats', { headers: { authorization: 'Bearer ' + token } });
  if (st.json && st.json.code === 0 && st.json.data) {
    todayCost = numOrNull(st.json.data.today_actual_cost);
    totalCost = numOrNull(st.json.data.total_actual_cost);
  }
  return { framework: 'sub2api', name, balance, todayCost, totalCost };
}

/* ------------------------- New API ------------------------- */
// 密码模式: POST /api/user/login {username,password} -> Set-Cookie session + data.id
// 余额:     GET  /api/user/self  头 Cookie: session=.. 且 New-Api-User: <uid> -> data.quota
// 令牌模式: GET  /api/user/self  头 Authorization: Bearer <accessToken> 且 New-Api-User: <uid>
function normalizeNewapi(d, site) {
  const per = Number(site.quotaPerUnit) > 0 ? Number(site.quotaPerUnit) : NEWAPI_QUOTA_PER_UNIT;
  return {
    framework: 'newapi',
    name: d.display_name || d.username || site.username || site.baseUrl,
    balance: (d.quota || 0) / per,
    used: (d.used_quota || 0) / per,
    requestCount: d.request_count || 0,
  };
}

async function newapiBalance(site) {
  const base = stripSlash(site.baseUrl);
  let uid = site.userId ? String(site.userId) : '';
  if (site.accessToken) {
    const r = await http(base + '/api/user/self', {
      headers: { authorization: 'Bearer ' + site.accessToken, 'new-api-user': uid, 'user-agent': 'TokenBuddyTray/0.1' },
    });
    if (r.json && r.json.success) return normalizeNewapi(r.json.data || {}, site);
    if (r.status !== 401 && r.status !== 403) {
      throw new Error((r.json && r.json.message) || 'HTTP ' + r.status);
    }
  }
  const lr = await jpost(base + '/api/user/login', { username: site.username, password: site.password });
  if (!lr.json || !lr.json.success) {
    throw new Error((lr.json && lr.json.message) || 'login failed (HTTP ' + lr.status + ')');
  }
  if (lr.json.data && lr.json.data.id && !uid) uid = String(lr.json.data.id);
  const rawCookie = lr.headers.get('set-cookie') || '';
  const cookie = rawCookie.split(';')[0];
  const sr = await http(base + '/api/user/self', {
    headers: { cookie, 'new-api-user': uid, 'user-agent': 'TokenBuddyTray/0.1' },
  });
  if (!sr.json || !sr.json.success) {
    throw new Error((sr.json && sr.json.message) || 'self failed (HTTP ' + sr.status + ')');
  }
  return normalizeNewapi(sr.json.data || {}, site);
}

function numOrNull(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

async function fetchBalance(site) {
  if (!site || !site.baseUrl) throw new Error('missing baseUrl');
  const type = (site.type || 'sub2api').toLowerCase();
  if (type === 'newapi' || type === 'new-api') return newapiBalance(site);
  if (type === 'sub2api') return sub2apiBalance(site);
  throw new Error('unknown site type: ' + site.type);
}

module.exports = { fetchBalance, sub2apiBalance, newapiBalance };
