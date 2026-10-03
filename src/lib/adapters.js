'use strict';

/*
 * 余额适配器。目标:适配绝大多数中转站。
 * 主流中转站基本是两套架构:
 *   - Sub2API   : GET /v1/usage                (API Key 直查账户钱包余额)
 *                 POST /api/v1/auth/login       (账号密码,返回 JWT)
 *   - New API / One API : GET /api/status       (公开端点,用于识别架构)
 *                         POST /api/user/login   (账号密码,返回 JWT + 完整 user 对象)
 *                         GET /v1/dashboard/billing/subscription (API Key;注意是"总额度"不是余额)
 *
 * 架构识别:只凭站点地址,不消耗任何凭据,全部是未鉴权的单次 GET/POST。
 * New API 余额:账号密码走纯 HTTP 登录,不启动浏览器。
 */

const UA = 'TokenBuddyTray/0.1';
const DEFAULT_TIMEOUT = 15000;
const NEWAPI_QUOTA_PER_UNIT = 500000; // New API 默认值;实际以站点 /api/status 的 quota_per_unit 为准
// New API 源码 controller/billing.go:56-57 —— UnlimitedQuota 的 token 被硬编码回这个值,与真实余额无关
const NEWAPI_UNLIMITED_SENTINEL = 100000000;

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
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
  });
}
function bearer(key, extra) {
  return { authorization: 'Bearer ' + key, 'user-agent': UA, ...(extra || {}) };
}

/* ============ 架构识别:仅凭站点地址,无需任何凭据 ============ */
async function detectFramework(baseUrl) {
  const base = stripSlash(baseUrl);
  const out = { framework: null, quotaPerUnit: null, displayType: null, usdExchangeRate: null, tried: [] };
  if (!base) return out;

  // New API:/api/status 是公开端点
  try {
    const s = await http(base + '/api/status');
    if (s.status === 200 && s.json && s.json.data) {
      out.framework = 'newapi';
      const d = s.json.data;
      if (Number(d.quota_per_unit) > 0) out.quotaPerUnit = Number(d.quota_per_unit);
      if (d.quota_display_type) out.displayType = String(d.quota_display_type);
      if (Number(d.usd_exchange_rate) > 0) out.usdExchangeRate = Number(d.usd_exchange_rate);
      return out;
    }
    out.tried.push('GET /api/status → ' + s.status);
  } catch (e) { out.tried.push('GET /api/status → ' + e.message); }

  // Sub2API:GET /v1/usage 不带 Key 时返回 401 且提示 API_KEY_REQUIRED
  try {
    const u = await http(base + '/v1/usage');
    if ((u.status === 401 || u.status === 403) && /API_KEY_REQUIRED|API key is required/i.test(u.text)) {
      out.framework = 'sub2api';
      return out;
    }
    out.tried.push('GET /v1/usage → ' + u.status);
  } catch (e) { out.tried.push('GET /v1/usage → ' + e.message); }

  // Sub2API 登录端点存在性:参数校验错(400/422)说明路由存在
  try {
    const l = await http(base + '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: '{}',
    });
    if (l.status === 400 || l.status === 422) { out.framework = 'sub2api'; return out; }
    out.tried.push('POST /api/v1/auth/login → ' + l.status);
  } catch (e) { out.tried.push('POST /api/v1/auth/login → ' + e.message); }

  return out;
}

/* ============ New API 额度换算 ============ */
// 单位标签直接采用站点自己的 quota_display_type,不擅自假定 USD
function newapiUnitLabel(displayType) {
  if (displayType === 'CNY') return 'CNY';
  if (displayType === 'TOKENS') return 'TOKENS';
  return 'USD';
}
// 换算公式与 New API 源码 controller/billing.go:48-55 保持一致
function newapiQuotaToDisplay(q, meta) {
  if (meta.displayType === 'TOKENS') return q;
  if (meta.displayType === 'CNY') return q / meta.quotaPerUnit * meta.usdExchangeRate;
  return q / meta.quotaPerUnit;
}
// 取值优先级:站点自定义 quotaPerUnit > 站点 /api/status > New API 默认值
function newapiMeta(det, site) {
  const s = site || {};
  const per = Number(s.quotaPerUnit) > 0 ? Number(s.quotaPerUnit)
    : (det && det.quotaPerUnit) ? det.quotaPerUnit
      : NEWAPI_QUOTA_PER_UNIT;
  const displayType = (det && det.displayType) || 'USD';
  const rate = det && det.usdExchangeRate > 0 ? det.usdExchangeRate : 1;
  return { quotaPerUnit: per, displayType, usdExchangeRate: rate, unit: newapiUnitLabel(displayType) };
}

/* ============ 方式一:API Key 直查 ============ */
async function sub2apiByKey(base, key, site) {
  // /v1/usage 同时返回 balance 与 remaining(同值),都是账户级钱包真实剩余余额
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
  throw new Error('Sub2API /v1/usage 未返回余额(HTTP ' + r.status + ')');
}

async function newapiByKey(base, key, site, det) {
  const sub = await http(base + '/v1/dashboard/billing/subscription', { headers: bearer(key) });
  if (sub.status !== 200 || !sub.json || typeof sub.json.hard_limit_usd !== 'number') {
    throw new Error('New API 计费接口未开放该 Key(HTTP ' + sub.status + '),需改用账号密码');
  }
  let used = null;
  try {
    const end = new Date();
    const start = new Date(Date.now() - 90 * 864e5);
    const u = await http(base + '/v1/dashboard/billing/usage?start_date=' + iso(start) + '&end_date=' + iso(end), { headers: bearer(key) });
    if (u.json && typeof u.json.total_usage === 'number') used = u.json.total_usage / 100;
  } catch (e) {}

  const meta = newapiMeta(det, site);
  // 源码 controller/billing.go:41 —— hard_limit_usd = (剩余 + 已用) / QuotaPerUnit,是"总额度"而非剩余余额
  const granted = sub.json.hard_limit_usd;
  // 源码 controller/billing.go:56-57 —— UnlimitedQuota 的 token 固定回 100000000,该数字与真实余额无关
  const unlimited = granted === NEWAPI_UNLIMITED_SENTINEL;
  // 已用拿不到时不做减法,避免把总额度误当余额显示
  const balance = (unlimited || used == null) ? null : granted - used;
  return {
    framework: 'newapi', name: site.name || base,
    balance, unit: meta.unit, limit: granted, totalCost: used,
    unlimited,
    unlimitedHint: unlimited ? '该 Key 为无限额度,New API 不返回真实余额;需填写账号密码' : null,
  };
}

async function fetchByApiKey(site) {
  const base = stripSlash(site.baseUrl);
  const det = await detectFramework(base);
  if (det.framework === 'sub2api') return sub2apiByKey(base, site.apiKey, site);
  if (det.framework === 'newapi') return newapiByKey(base, site.apiKey, site, det);
  throw new Error('无法识别站点架构(既不是 Sub2API 也不是 New API)。已探测:' + det.tried.join(' | '));
}

/* ============ 方式二:账号密码(纯 HTTP,不启动浏览器) ============ */
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

function normalizeNewapiUser(d, site, meta, nameHint) {
  return {
    framework: 'newapi', name: d.display_name || d.username || nameHint || site.username || site.baseUrl,
    balance: newapiQuotaToDisplay(d.quota || 0, meta), unit: meta.unit,
    used: newapiQuotaToDisplay(d.used_quota || 0, meta),
    totalCost: newapiQuotaToDisplay(d.used_quota || 0, meta),
    requestCount: d.request_count || 0,
  };
}

async function newapiLogin(site, det) {
  const base = stripSlash(site.baseUrl);
  const meta = newapiMeta(det || (await detectFramework(base)), site);
  const lr = await jpost(base + '/api/user/login', { username: site.username, password: site.password });
  if (!lr.json || !lr.json.success) throw new Error((lr.json && lr.json.message) || 'login failed (HTTP ' + lr.status + ')');
  const d = lr.json.data || {};
  // 新版 New API:登录响应里已带完整 user 对象(含 quota / used_quota),无需再请求 /api/user/self
  if (d.user && typeof d.user.quota === 'number') return normalizeNewapiUser(d.user, site, meta, d.user.username);
  // 旧版 New API:只有 Set-Cookie,需带 cookie + New-Api-User 再查 /api/user/self
  let uid = site.userId ? String(site.userId) : (d.id ? String(d.id) : '');
  const headers = { 'user-agent': UA };
  if (d.access_token) headers.authorization = 'Bearer ' + d.access_token;
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  if (cookie) headers.cookie = cookie;
  if (uid) headers['new-api-user'] = uid;
  const sr = await http(base + '/api/user/self', { headers });
  if (!sr.json || !sr.json.success) throw new Error((sr.json && sr.json.message) || 'self failed (HTTP ' + sr.status + ')');
  return normalizeNewapiUser(sr.json.data || {}, site, meta);
}

/* ============ 统一入口 ============ */
// 架构探测失败时,按用户填的类型兜底
function frameworkFromType(site) {
  const t = String(site.type || '').toLowerCase();
  if (t === 'sub2api' || t === 'sub2') return 'sub2api';
  if (t === 'newapi' || t === 'new-api' || t === 'oneapi' || t === 'one-api') return 'newapi';
  if (site.email) return 'sub2api';
  return null;
}

async function fetchBalance(site) {
  if (!site || !site.baseUrl) throw new Error('缺少站点地址');
  const base = stripSlash(site.baseUrl);
  const det = await detectFramework(base);
  const fw = det.framework || frameworkFromType(site);
  const hasCreds = !!(site.username && site.password);

  if (fw === 'sub2api') {
    // Sub2API 的 Key 直查返回的就是账户钱包真实余额,优于登录态,所以优先用 Key
    if (site.apiKey) return sub2apiByKey(base, site.apiKey, site);
    return sub2apiLogin(site);
  }
  if (fw === 'newapi') {
    // New API 的 Key 只能反映"该 Key 的额度",无限额度 Key 会返回无意义的哨兵值;
    // 账户真实余额只能由账号密码取到,所以两者都有时优先登录
    if (hasCreds) return newapiLogin(site, det);
    if (site.apiKey) return newapiByKey(base, site.apiKey, site, det);
    return newapiLogin(site, det);
  }
  throw new Error('无法识别站点架构(既不是 Sub2API 也不是 New API)。已探测:' + det.tried.join(' | '));
}

module.exports = {
  fetchBalance, fetchByApiKey, sub2apiLogin, newapiLogin, detectFramework,
  sub2apiByKey, newapiByKey, newapiQuotaToDisplay, NEWAPI_QUOTA_PER_UNIT, NEWAPI_UNLIMITED_SENTINEL,
};
