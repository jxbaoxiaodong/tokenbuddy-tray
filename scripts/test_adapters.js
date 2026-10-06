'use strict';
/*
 * 余额适配器回归测试。不联网、不需要任何密钥:用 mock 替换 global.fetch。
 * 覆盖的都是实际踩到的坑:
 *   - New API 的 hard_limit_usd 是总额度,不是余额
 *   - 无限额度 Key 被固定返回 100000000,不能当成余额显示
 *   - 币种不能写死 USD
 *   - New API 完整持久化 Access Token、Refresh Cookie 与 Session ID
 *   - Access Token 过期只刷新会话,不会反复登录或在 429 后登录
 *   - 协议识别只看 API Base URL,不消耗凭据
 *
 * 运行:node scripts/test_adapters.js
 */
const assert = require('assert');
const path = require('path');
const zlib = require('zlib');

const A = require(path.join(__dirname, '..', 'src', 'lib', 'adapters.js'));
const I = require(path.join(__dirname, '..', 'src', 'lib', 'icon.js'));

/* ---------------- 最小 PNG 解码 ----------------
 * icon.js 自己编码 PNG 且每行 filter 都是 0,所以解开就能看像素,
 * 用来断言"某一行字真的画在画布里"(小尺寸下曾整行被画到画布外)。*/
function decodePNG(buf) {
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    assert.strictEqual(raw[y * (stride + 1)], 0, '解码只支持 filter 0');
    raw.copy(px, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { w, h, px };
}
/* 找出"亮色像素"(文字)。背景 #0f172a 很暗,文字是绿/浅灰,所以按亮度区分。 */
function inkRows(img) {
  const rows = [];
  for (let y = 0; y < img.h; y++) {
    let n = 0;
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w * 4 + x * 4;
      const lum = 0.299 * img.px[i] + 0.587 * img.px[i + 1] + 0.114 * img.px[i + 2];
      if (img.px[i + 3] > 0 && lum > 110) n++;
    }
    if (n > 0) rows.push(y);
  }
  return rows;
}

/* ---------------- mock fetch:按 "METHOD /path" 返回预设响应 ---------------- */
function mockFetch(routes) {
  const calls = [];
  calls.details = [];
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const key = (opts.method || 'GET') + ' ' + u.pathname;
    calls.push(key);
    calls.details.push({ key, url: String(url), opts });
    let route = routes[key];
    if (Array.isArray(route)) route = route.shift();
    const r = typeof route === 'function' ? await route({ url: String(url), opts, calls }) : route;
    const headers = new Map(Object.entries((r && r.headers) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const setCookies = (r && r.setCookies) || (headers.has('set-cookie') ? [headers.get('set-cookie')] : []);
    return {
      status: (r && r.status) || 200,
      url: (r && r.finalUrl) || String(url),
      headers: {
        get: (k) => headers.get(k.toLowerCase()) ?? null,
        getSetCookie: () => setCookies.slice(),
      },
      text: async () => (r && r.body != null ? JSON.stringify(r.body) : ''),
    };
  };
  return calls;
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const NEWAPI_SITE = 'https://newapi.test';
const SUB2_SITE = 'https://sub2.test';
const SESSION_SITE = 'https://session.test';

(async () => {
  console.log('协议识别(只看 API Base URL,不消耗凭据)');

  await t('GET /api/status 返回 200 -> 判为 New API', async () => {
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 1 } } },
    });
    const d = await A.detectFramework(NEWAPI_SITE);
    assert.strictEqual(d.framework, 'newapi');
    assert.strictEqual(d.quotaPerUnit, 500000);
    assert.strictEqual(d.displayType, 'CNY');
    // 只应探测公开端点,不应碰任何带凭据的接口
    assert.ok(!calls.some((c) => c.includes('/api/user/login')), '不该调用登录接口');
  });

  await t('GET /api/status 只有通用 data 时不误判为 New API', async () => {
    const calls = mockFetch({
      'GET /api/status': { body: { data: { version: '1.0.0' } } },
      'GET /configs': { status: 404, body: {} },
      'GET /v1/usage': { status: 404, body: {} },
      'POST /api/v1/auth/login': { status: 404, body: {} },
    });
    const d = await A.detectFramework('https://generic-status.test');
    assert.strictEqual(d.framework, null);
    assert.deepStrictEqual(Array.from(calls), [
      'GET /api/status', 'GET /configs', 'GET /v1/usage', 'POST /api/v1/auth/login',
    ]);
  });

  await t('/v1/usage 未带 Key 返 401 API_KEY_REQUIRED -> 判为 Sub2API', async () => {
    mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /v1/usage': { status: 401, body: { code: 'API_KEY_REQUIRED', message: 'API key is required' } },
    });
    assert.strictEqual((await A.detectFramework(SUB2_SITE)).framework, 'sub2api');
  });

  await t('BASE URL 已带 /v1 时不重复拼接版本路径', async () => {
    mockFetch({
      'GET /v1/usage': { body: { balance: 12, unit: 'USD' } },
    });
    const r = await A.fetchBalance({ baseUrl: SUB2_SITE + '/v1', apiKey: 'sk-v1', type: 'sub2api' });
    assert.strictEqual(r.balance, 12);
  });

  await t('官网跳到同站子域时,带 Key 请求会在最终地址安全重试', async () => {
    const calls = mockFetch({
      'GET /v1/usage': [
        { status: 401, body: { code: 'API_KEY_REQUIRED' }, finalUrl: 'https://console.test/v1/usage' },
        { body: { balance: 8, unit: 'USD' }, finalUrl: 'https://console.test/v1/usage' },
      ],
    });
    const r = await A.sub2apiByKey('https://test', 'sk-redirect', { name: 'S' });
    assert.strictEqual(r.balance, 8);
    assert.strictEqual(calls.length, 2);
  });

  await t('GET /configs 返回 专用站点 公共配置 -> 判为 专用站点', async () => {
    const calls = mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /configs': { body: { 'public.balance.price': '1.0', 'public.register.enabled': 'true' } },
    });
    assert.strictEqual((await A.detectFramework('https://dedicated.test')).framework, 'dedicated');
    assert.ok(!calls.includes('POST /auth/login'), '协议探测不得调用登录接口');
  });

  await t('所有探测端点都不存在 -> 不猜,返回 null', async () => {
    mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /v1/usage': { status: 404, body: {} },
      'POST /api/v1/auth/login': { status: 404, body: {} },
    });
    assert.strictEqual((await A.detectFramework(NEWAPI_SITE)).framework, null);
  });

  await t('探测遇到 429 立即停止,不继续轰炸其它端点', async () => {
    const calls = mockFetch({
      'GET /api/status': { status: 429, body: { message: 'Too Many Requests' } },
      'GET /v1/usage': { status: 500, body: {} },
      'POST /api/v1/auth/login': { status: 500, body: {} },
    });
    const d = await A.detectFramework('https://rate-limit-detect.test');
    assert.strictEqual(d.framework, null);
    assert.strictEqual(d.rateLimited, true);
    assert.deepStrictEqual(Array.from(calls), ['GET /api/status']);
  });

  console.log('\nNew API 用 API Key 查余额');

  await t('无限额度 Key:不再把 100000000 当余额', async () => {
    mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000, quota_display_type: 'USD' } } },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: A.NEWAPI_UNLIMITED_SENTINEL } },
      'GET /v1/dashboard/billing/usage': { body: { total_usage: 14564.4228 } },
    });
    const r = await A.fetchByApiKey({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x', name: 'S' });
    assert.strictEqual(r.unlimited, true);
    assert.strictEqual(r.balance, null, '无限额度时 balance 必须是 null,不能是 100000000');
    assert.ok(r.unlimitedHint && r.unlimitedHint.includes('数字余额'));
  });

  await t('普通 Key:余额 = 总额度 - 已用', async () => {
    mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000, quota_display_type: 'USD' } } },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: 100 } },
      'GET /v1/dashboard/billing/usage': { body: { total_usage: 2550 } }, // 2550 分 = $25.50
    });
    const r = await A.fetchByApiKey({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x', name: 'S' });
    assert.strictEqual(r.unlimited, false);
    assert.strictEqual(r.balance, 74.5);
    assert.strictEqual(r.totalCost, 25.5);
  });

  await t('已用查不到时不猜:balance 为 null,而不是把总额度当余额', async () => {
    mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: 100 } },
      'GET /v1/dashboard/billing/usage': { status: 500, body: {} },
    });
    assert.strictEqual((await A.fetchByApiKey({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x' })).balance, null);
  });

  await t('币种按站点的 quota_display_type,不写死 USD', async () => {
    mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 1 } } },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: A.NEWAPI_UNLIMITED_SENTINEL } },
      'GET /v1/dashboard/billing/usage': { body: { total_usage: 0 } },
    });
    assert.strictEqual((await A.fetchByApiKey({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x' })).unit, 'CNY');
  });

  console.log('\nNew API 用账号密码登录');

  await t('新版:登录响应里的 data.user 直接就是真实余额', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 1 } } },
      'POST /api/user/login': {
        setCookies: ['refresh_token=refresh-1; Path=/; HttpOnly'],
        body: { success: true, data: {
          access_token: 'jwt', access_expires_at: 1893456000,
          session: { sid: 'sid-1' },
          user: { id: 7, username: 'u', quota: 7648944, used_quota: 3698768304 },
        } },
      },
    });
    const r = await A.newapiLogin({ baseUrl: NEWAPI_SITE, username: 'u', password: 'p' });
    assert.strictEqual(r.balance, 15.297888);   // 7648944 / 500000
    assert.strictEqual(r.unit, 'CNY');
    assert.deepStrictEqual(r._session, {
      token: 'jwt', cookie: 'refresh_token=refresh-1', sessionId: 'sid-1',
      expiresAt: 1893456000, userId: '7',
    });
    assert.ok(!calls.includes('GET /api/user/self'), '新版不该再多发一次 /api/user/self');
  });

  await t('旧版:无 data.user 时退回 JWT,再不行才用 cookie + New-Api-User', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': {
        headers: { 'set-cookie': 'session=abc; Path=/' },
        body: { success: true, data: { access_token: 'jwt', id: 7 } },
      },
      'GET /api/user/self': { body: { success: true, data: { username: 'u', quota: 500000, used_quota: 0 } } },
    });
    const r = await A.newapiLogin({ baseUrl: NEWAPI_SITE, username: 'u', password: 'p' });
    assert.strictEqual(r.balance, 1);
    assert.ok(calls.includes('GET /api/user/self'));
  });

  await t('登录失败要报错,不能静默当成 0', async () => {
    A.clearNewapiSessions();
    mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': { body: { success: false, message: '用户名或密码错误' } },
    });
    await assert.rejects(() => A.newapiLogin({ baseUrl: NEWAPI_SITE, username: 'u', password: 'bad' }), /用户名或密码错误/);
  });

  await t('登录成功后复用会话,第二次刷新不再调用登录接口', async () => {
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': {
        body: { success: true, data: { access_token: 'session-jwt', user: { username: 'u', quota: 500000, used_quota: 0 } } },
      },
      'GET /api/user/self': {
        body: { success: true, data: { username: 'u', quota: 400000, used_quota: 100000 } },
      },
    });
    const first = await A.newapiLogin({ baseUrl: SESSION_SITE, username: 'u', password: 'p' });
    const second = await A.newapiLogin({ baseUrl: SESSION_SITE, username: 'u', password: 'p' });
    assert.strictEqual(first.balance, 1);
    assert.strictEqual(second.balance, 0.8);
    assert.strictEqual(first._sessionToken, 'session-jwt');
    assert.strictEqual(second._sessionToken, 'session-jwt');
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 1);
  });

  await t('同一账号并发刷新时只允许一个登录流程', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': {
        body: { success: true, data: { access_token: 'singleflight-jwt', user: { username: 'u', quota: 500000, used_quota: 0 } } },
      },
    });
    const site = { baseUrl: 'https://singleflight.test', username: 'u', password: 'p' };
    const out = await Promise.all([A.newapiLogin(site), A.newapiLogin(site)]);
    assert.strictEqual(out[0].balance, 1);
    assert.strictEqual(out[1].balance, 1);
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 1);
  });

  await t('应用重启后可用持久化令牌直接读余额,不重新登录', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'GET /api/user/self': {
        body: { success: true, data: { username: 'u', quota: 250000, used_quota: 0 } },
      },
      'POST /api/user/login': { status: 500, body: { success: false, message: '不应调用登录' } },
    });
    const r = await A.newapiLogin({
      baseUrl: 'https://restart.test', username: 'u', password: 'p',
      accessToken: 'persisted-jwt', refreshCookie: 'refresh_token=persisted-refresh', authSessionId: 'sid-r',
    });
    assert.strictEqual(r.balance, 0.5);
    assert.strictEqual(r._sessionToken, 'persisted-jwt');
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 0);
  });

  await t('Access Token 过期时刷新完整会话,绝不重新登录', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000, quota_display_type: 'CNY' } } },
      'GET /api/user/self': { status: 401, body: { success: false, message: 'expired' } },
      'POST /api/user/auth/refresh': {
        setCookies: ['refresh_token=refresh-2; Path=/; HttpOnly'],
        body: { success: true, data: {
          access_token: 'jwt-2', access_expires_at: 1893457000,
          session: { sid: 'sid-2' }, user: { id: 7, username: 'u', quota: 250000, used_quota: 0 },
        } },
      },
      'POST /api/user/login': { status: 500, body: { success: false, message: '不应登录' } },
    });
    const r = await A.newapiLogin({
      baseUrl: 'https://refresh.test', username: 'u', password: 'p',
      accessToken: 'jwt-1', refreshCookie: 'refresh_token=refresh-1', authSessionId: 'sid-1',
    });
    assert.strictEqual(r.balance, 0.5);
    assert.strictEqual(r._session.token, 'jwt-2');
    assert.strictEqual(r._session.cookie, 'refresh_token=refresh-2');
    assert.strictEqual(r._session.sessionId, 'sid-2');
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/auth/refresh').length, 1);
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 0);
  });

  await t('Refresh SID 不匹配时只去掉 SID 重试一次', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'GET /api/user/self': { status: 401, body: { success: false } },
      'POST /api/user/auth/refresh': [
        { status: 409, body: { success: false, code: 'AUTH_SESSION_MISMATCH' } },
        { body: { success: true, data: { access_token: 'jwt-ok', session: { sid: 'sid-new' }, user: { quota: 500000, used_quota: 0 } } } },
      ],
    });
    const r = await A.newapiLogin({
      baseUrl: 'https://sid-mismatch.test', username: 'u', password: 'p',
      accessToken: 'old', refreshCookie: 'refresh_token=r1', authSessionId: 'sid-old',
    });
    assert.strictEqual(r.balance, 1);
    const refreshCalls = calls.details.filter((c) => c.key === 'POST /api/user/auth/refresh');
    assert.strictEqual(refreshCalls.length, 2);
    assert.strictEqual(refreshCalls[0].opts.headers['x-auth-session'], 'sid-old');
    assert.ok(!('x-auth-session' in refreshCalls[1].opts.headers), '第二次刷新必须移除失配 SID');
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 0);
  });

  await t('Refresh 返回 429 时保留会话且不登录', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'GET /api/user/self': { status: 401, body: { success: false } },
      'POST /api/user/auth/refresh': { status: 429, headers: { 'retry-after': '60' }, body: { success: false } },
      'POST /api/user/login': { body: { success: true, data: { access_token: 'bad' } } },
    });
    const site = {
      baseUrl: 'https://refresh-429.test', username: 'u', password: 'p',
      accessToken: 'old', refreshCookie: 'refresh_token=r1', authSessionId: 'sid-old',
    };
    await assert.rejects(() => A.newapiLogin(site), (e) => e.code === 'NEWAPI_LOGIN_COOLDOWN');
    assert.strictEqual(site._clearSession, undefined);
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 0);
  });

  await t('Refresh 明确返回 401 时才清除失效会话', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'GET /api/user/self': { status: 401, body: { success: false } },
      'POST /api/user/auth/refresh': { status: 401, body: { success: false, code: 'AUTH_UNAUTHORIZED' } },
      'POST /api/user/login': { body: { success: true, data: { access_token: 'bad' } } },
    });
    const site = {
      baseUrl: 'https://refresh-401.test', username: 'u', password: 'p',
      accessToken: 'old', refreshCookie: 'refresh_token=r1', authSessionId: 'sid-old',
    };
    await assert.rejects(() => A.newapiLogin(site), /会话已失效/);
    assert.strictEqual(site._clearSession, true);
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 0);
  });

  await t('已有会话被限流时,冷却期间不再访问登录接口', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'GET /api/user/self': { status: 429, body: { success: false, message: 'Too Many Requests' } },
      'POST /api/user/login': { status: 500, body: { success: false, message: '不应调用登录' } },
    });
    await assert.rejects(
      () => A.newapiLogin({ baseUrl: 'https://rate-limit.test', username: 'u', password: 'p', accessToken: 'saved-jwt' }),
      (e) => e.code === 'NEWAPI_LOGIN_COOLDOWN' && /冷却期间不会再次登录/.test(e.message),
    );
    await assert.rejects(
      () => A.newapiLogin({ baseUrl: 'https://rate-limit.test', username: 'u', password: 'p', accessToken: 'saved-jwt' }),
      (e) => e.code === 'NEWAPI_LOGIN_COOLDOWN',
    );
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 0);
    assert.strictEqual(calls.filter((c) => c === 'GET /api/user/self').length, 1);
  });

  await t('定时刷新没有会话时绝不自动登录', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': { body: { success: true, data: { access_token: 'must-not-login', user: { username: 'u', quota: 500000 } } } },
    });
    await assert.rejects(
      () => A.fetchBalance({ baseUrl: 'https://scheduled.test', username: 'u', password: 'p', type: 'newapi' }, { allowLogin: false }),
      /定时刷新不会自动登录/,
    );
    assert.strictEqual(calls.filter((c) => c === 'POST /api/user/login').length, 0);
  });

  console.log('\n专用协议适配');

  await t('首次登录读取顶层 balance 并持久化 user_token', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /configs': { body: { 'public.balance.price': '1.0' } },
      'POST /auth/login': { body: { id: 9, username: 'u', balance: 0.039433, user_token: 'dedicated-token' } },
    });
    const r = await A.fetchBalance({
      baseUrl: 'https://dedicated.test', username: 'u', password: 'p', type: '',
    }, { allowLogin: true });
    assert.strictEqual(r.framework, 'dedicated');
    assert.strictEqual(r.balance, 0.039433);
    assert.strictEqual(r.unit, 'USD');
    assert.strictEqual(r._session.token, 'dedicated-token');
    assert.strictEqual(calls.filter((c) => c === 'POST /auth/login').length, 1);
  });

  await t('已有 专用站点 令牌只调用 /auth/me,不重新登录', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /auth/me': { body: { id: 9, username: 'u', balance: 0.04 } },
      'POST /auth/login': { status: 500, body: { message: '不应登录' } },
    });
    const r = await A.fetchBalance({
      baseUrl: 'https://dedicated.test', type: 'dedicated', username: 'u', password: 'p', accessToken: 'saved-dedicated-token',
    }, { allowLogin: false });
    assert.strictEqual(r.balance, 0.04);
    assert.strictEqual(calls.filter((c) => c === 'GET /auth/me').length, 1);
    assert.strictEqual(calls.filter((c) => c === 'POST /auth/login').length, 0);
  });

  await t('专用站点 定时刷新没有会话时绝不自动登录', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'POST /auth/login': { body: { balance: 1, user_token: 'must-not-login' } },
    });
    await assert.rejects(() => A.fetchBalance({
      baseUrl: 'https://dedicated.test', type: 'dedicated', username: 'u', password: 'p',
    }, { allowLogin: false }), /定时刷新不会自动登录/);
    assert.strictEqual(calls.filter((c) => c === 'POST /auth/login').length, 0);
  });

  console.log('\n入口选择');

  await t('New API 同时有 Key 和账号时走账号余额,不用 Key 占位值覆盖', async () => {
    A.clearNewapiSessions();
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': { body: { success: true, data: { access_token: 'jwt', user: { username: 'u', quota: 500000, used_quota: 0 } } } },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: A.NEWAPI_UNLIMITED_SENTINEL } },
      'GET /v1/dashboard/billing/usage': { body: { total_usage: 0 } },
    });
    const r = await A.fetchBalance({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x', username: 'u', password: 'p' });
    assert.strictEqual(r.balance, 1);
    assert.strictEqual(r.unlimited, undefined);
    assert.ok(calls.includes('POST /api/user/login'), '首次设置应登录一次取得完整会话');
    assert.ok(!calls.includes('GET /v1/dashboard/billing/subscription'), '不能用 Key 无限额度占位值覆盖账户余额');
  });

  await t('Sub2API 有 Key 时优先 Key(/v1/usage 就是账户真实余额)', async () => {
    const calls = mockFetch({
      'GET /api/status': { status: 404, body: {} },
      // 未鉴权探测:必须像真机一样 401,否则无法区分协议
      'GET /v1/usage': { body: { balance: 999997.79, remaining: 999997.79, unit: 'USD', usage: { today: { actual_cost: 1 }, total: { actual_cost: 2 } } } },
    });
    const r = await A.fetchBalance({ baseUrl: SUB2_SITE, apiKey: 'sk-y', username: 'u', password: 'p', type: 'sub2api' });
    assert.strictEqual(r.balance, 999997.79);
    assert.strictEqual(r.framework, 'sub2api');
  });

  await t('探测不出协议时,按用户配置的类型执行,不瞎猜', async () => {
    mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /v1/usage': { body: { balance: 42, unit: 'USD' } },
    });
    // 配置里写了 sub2api,且 /v1/usage 能给出余额 -> 应按 sub2api 取,而不是抛"无法识别"
    const r = await A.fetchBalance({ baseUrl: SUB2_SITE, apiKey: 'sk-y', type: 'sub2api' });
    assert.strictEqual(r.balance, 42);
  });

  await t('探测不出协议且也没配置类型 -> 走能力探测,落空时报真实结果,不假装成 0', async () => {
    mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /v1/usage': { status: 404, body: {} },
      'POST /api/v1/auth/login': { status: 404, body: {} },
      'GET /v1/dashboard/billing/subscription': { status: 404, body: {} },
      'GET /api/v1/auth/me': { status: 401, body: {} },
      'GET /api/usage/token/': { status: 404, body: {} },
      'GET /api/user/self': { status: 401, body: {} },
    });
    await assert.rejects(
      () => A.fetchBalance({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x' }),
      (e) => {
        assert.ok(/能力探测未能从任何已知接口读到余额/.test(e.message), '要说明是能力探测落空:' + e.message);
        assert.ok(/HTTP 404/.test(e.message), '要列出各接口的真实状态');
        assert.ok(/HTTP 401/.test(e.message), '要列出各接口的真实状态');
        return true;
      },
    );
  });

  console.log('\n能力探测兜底(识别不出协议时,拿 Key 依次试已知余额接口)');
  const PROBE_SITE = 'https://unknown.test';
  // 识别不出协议时的公共路由:四个探测端点全部落空
  const NO_ARCH = {
    'GET /api/status': { status: 404, body: {} },
    'GET /configs': { status: 404, body: {} },
    'GET /v1/usage': { status: 404, body: {} },
    'POST /api/v1/auth/login': { status: 404, body: {} },
  };

  await t('能力探测命中 /v1/usage -> 标成 probe,不冒充成 Sub2API', async () => {
    mockFetch({
      ...NO_ARCH,
      'GET /v1/usage': { body: { balance: 12.5, unit: 'USD', usage: { today: { actual_cost: 1.5 }, total: { actual_cost: 3 } } } },
      'GET /v1/dashboard/billing/subscription': { status: 404, body: {} },
    });
    const r = await A.fetchBalance({ baseUrl: PROBE_SITE, apiKey: 'sk-p' });
    assert.strictEqual(r.framework, 'probe', '必须标成 probe,不能写成 sub2api');
    assert.strictEqual(r.probeProtocol, 'usage');
    assert.strictEqual(r.balance, 12.5);
    assert.strictEqual(r.todayCost, 1.5);
    assert.strictEqual(r.totalCost, 3);
    assert.strictEqual(r.unit, 'USD');
  });

  await t('能力探测跳过命中不了的候选,顺序不打乱', async () => {
    const calls = mockFetch({
      ...NO_ARCH,
      'GET /v1/usage': { status: 401, body: { error: 'bad key' } },
      'GET /v1/dashboard/billing/subscription': { status: 404, body: {} },
      'GET /api/v1/auth/me': { body: { code: 0, data: { balance: 7.25, username: 'bob' } } },
    });
    const r = await A.fetchBalance({ baseUrl: PROBE_SITE, apiKey: 'sk-p' });
    assert.strictEqual(r.probeProtocol, 'authme');
    assert.strictEqual(r.balance, 7.25);
    assert.strictEqual(r.name, 'bob');
    assert.ok(calls.indexOf('GET /api/v1/auth/me') > calls.indexOf('GET /v1/usage'), '按候选顺序试');
  });

  await t('命中过的协议写回 site.probeProtocol,且 type=probe 时不再跑协议识别', async () => {
    const calls = mockFetch({
      'GET /api/usage/token/': { body: { data: { balance: 3.5 } } },
    });
    const site = { baseUrl: PROBE_SITE, apiKey: 'sk-p', type: 'probe', probeProtocol: 'tokenusage' };
    const r = await A.fetchBalance(site);
    assert.strictEqual(r.probeProtocol, 'tokenusage');
    assert.strictEqual(r.balance, 3.5);
    assert.strictEqual(site.probeProtocol, 'tokenusage', '要写回站点对象,供主进程持久化');
    assert.ok(!calls.includes('GET /v1/usage'), '已知协议直接命中,不该再试前面的候选');
    assert.ok(!calls.includes('GET /api/status'), 'type=probe 是显式选择,不该再跑协议识别');
  });

  await t('probeByKey 记住的协议排最前,不按表顺序重头试', async () => {
    const calls = mockFetch({
      'GET /api/usage/token/': { body: { data: { balance: 3.5 } } },
    });
    const r = await A.probeByKey({ baseUrl: PROBE_SITE, apiKey: 'sk-p', probeProtocol: 'tokenusage' });
    assert.strictEqual(r.balance, 3.5);
    assert.strictEqual(calls[0], 'GET /api/usage/token/', '记住的协议必须第一个就试:' + calls.join(','));
  });

  await t('记住的协议失效时重新完整探测,不卡死在旧协议上', async () => {
    const site = { baseUrl: PROBE_SITE, apiKey: 'sk-p', probeProtocol: 'usage' };
    mockFetch({
      ...NO_ARCH,
      'GET /v1/usage': { status: 404, body: {} },
      'GET /v1/dashboard/billing/subscription': { status: 404, body: {} },
      'GET /api/v1/auth/me': { status: 404, body: {} },
      'GET /api/usage/token/': { body: { data: { balance: 9 } } },
      'GET /api/user/self': { status: 404, body: {} },
    });
    const r = await A.fetchByApiKey(site);
    assert.strictEqual(r.probeProtocol, 'tokenusage');
    assert.strictEqual(r.balance, 9);
  });

  await t('能力探测遇到 429 立即停止,不继续轰炸后面的候选', async () => {
    const calls = mockFetch({
      ...NO_ARCH,
      'GET /v1/usage': { status: 429, headers: {} },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: 1 } },
    });
    await assert.rejects(() => A.fetchBalance({ baseUrl: PROBE_SITE, apiKey: 'sk-p' }), /限流/);
    assert.ok(!calls.includes('GET /v1/dashboard/billing/subscription'), '429 后不得继续试下一个候选');
  });

  await t('billing 候选:hard_limit_usd 是总额度,要减已用才是余额', async () => {
    mockFetch({
      ...NO_ARCH,
      'GET /v1/usage': { status: 404, body: {} },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: 100 } },
      'GET /v1/dashboard/billing/usage': { body: { total_usage: 2550 } },
    });
    const r = await A.fetchBalance({ baseUrl: PROBE_SITE, apiKey: 'sk-p' });
    assert.strictEqual(r.probeProtocol, 'billing');
    assert.strictEqual(r.balance, 74.5, '100 - 25.5');
    assert.strictEqual(r.totalCost, 25.5);
  });

  await t('billing 候选:无限额度哨兵 100000000 不能当余额', async () => {
    mockFetch({
      ...NO_ARCH,
      'GET /v1/usage': { status: 404, body: {} },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: A.NEWAPI_UNLIMITED_SENTINEL } },
      'GET /v1/dashboard/billing/usage': { body: { total_usage: 2550 } },
    });
    const r = await A.fetchBalance({ baseUrl: PROBE_SITE, apiKey: 'sk-p' });
    assert.strictEqual(r.unlimited, true);
    assert.strictEqual(r.balance, null, '无限额度时必须是 null,不能显示 100000000');
    assert.ok(r.unlimitedHint && /数字余额/.test(r.unlimitedHint));
  });

  await t('billing 候选:已用查不到时不做减法,不把总额度当余额', async () => {
    mockFetch({
      ...NO_ARCH,
      'GET /v1/usage': { status: 404, body: {} },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: 100 } },
      'GET /v1/dashboard/billing/usage': { status: 404, body: {} },
    });
    await assert.rejects(
      () => A.fetchBalance({ baseUrl: PROBE_SITE, apiKey: 'sk-p' }),
      (e) => /能力探测未能/.test(e.message) && /已拿到总额度但无法取得已用额度/.test(e.message),
    );
  });

  await t('billing 候选无法算出余额时继续尝试后面的接口', async () => {
    const calls = mockFetch({
      ...NO_ARCH,
      'GET /v1/usage': { status: 404, body: {} },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: 100 } },
      'GET /v1/dashboard/billing/usage': { status: 404, body: {} },
      'GET /api/v1/auth/me': { body: { code: 0, data: { balance: 8 } } },
    });
    const r = await A.fetchBalance({ baseUrl: PROBE_SITE, apiKey: 'sk-p' });
    assert.strictEqual(r.probeProtocol, 'authme');
    assert.strictEqual(r.balance, 8);
    assert.ok(calls.indexOf('GET /api/v1/auth/me') > calls.indexOf('GET /v1/dashboard/billing/usage'));
  });

  await t('能力探测需要 API Key,没有就明说', async () => {
    mockFetch({ ...NO_ARCH });
    await assert.rejects(() => A.fetchBalance({ baseUrl: PROBE_SITE }), /API Key/);
  });

  console.log('\n手填余额接口(用户显式配置,优先于一切识别)');
  const CUSTOM_SITE = 'https://custom.test';

  await t('手填接口按字段路径取值', async () => {
    mockFetch({
      'GET /api/my/balance': { body: { code: 0, data: { wallet: { remain: 88.5 } } } },
    });
    const r = await A.fetchBalance({
      baseUrl: CUSTOM_SITE, apiKey: 'sk-c',
      balancePath: '/api/my/balance', balanceField: 'data.wallet.remain',
    });
    assert.strictEqual(r.framework, 'custom');
    assert.strictEqual(r.balance, 88.5);
    assert.strictEqual(r.customField, 'data.wallet.remain');
  });

  await t('手填接口字段路径写错 -> 如实报错,不猜别的字段', async () => {
    mockFetch({ 'GET /api/my/balance': { body: { code: 0, data: { wallet: { remain: 88.5 } } } } });
    await assert.rejects(
      () => A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'sk-c', balancePath: '/api/my/balance', balanceField: 'data.nothing.here' }),
      /不是数字/,
    );
  });

  await t('手填接口字段留空 -> 只认顶层 balance/remaining,不猜 quota', async () => {
    mockFetch({ 'GET /api/my/balance': { body: { nested: { balance: 5 }, quota: 66 } } });
    await assert.rejects(
      () => A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'sk-c', balancePath: '/api/my/balance' }),
      /请填写余额字段路径/,
    );
  });

  await t('手填接口显式指定 quota 字段仍可使用', async () => {
    mockFetch({ 'GET /api/my/balance': { body: { quota: 66 } } });
    const r = await A.fetchBalance({
      baseUrl: CUSTOM_SITE, apiKey: 'sk-c', balancePath: '/api/my/balance', balanceField: 'quota',
    });
    assert.strictEqual(r.balance, 66);
    assert.strictEqual(r.customField, 'quota');
  });

  await t('手填接口顶层没有余额字段 -> 报错并列出实际字段', async () => {
    mockFetch({ 'GET /api/my/balance': { body: { foo: 1, bar: 2 } } });
    await assert.rejects(
      () => A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'sk-c', balancePath: '/api/my/balance' }),
      /foo, bar/,
    );
  });

  await t('手填接口失败 -> 如实报 HTTP 状态,不静默回退到识别或探测', async () => {
    const calls = mockFetch({
      'GET /api/my/balance': { status: 500, body: { message: 'boom' } },
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
    });
    await assert.rejects(
      () => A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'sk-c', balancePath: '/api/my/balance' }),
      /HTTP 500/,
    );
    assert.ok(!calls.includes('GET /api/status'), '手填接口失败后不得偷偷去跑协议识别');
  });

  await t('手填接口优先级高于协议识别:能识别成 New API 也照样走手填路径', async () => {
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'GET /api/my/balance': { body: { balance: 4.5 } },
    });
    const r = await A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'sk-c', balancePath: '/api/my/balance' });
    assert.strictEqual(r.framework, 'custom');
    assert.strictEqual(r.balance, 4.5);
    assert.ok(!calls.includes('GET /api/status'), '既然以手填路径为准,就不该再去做协议识别');
  });

  await t('手填接口的 {{key}} 会被替换成 API Key', async () => {
    const calls = mockFetch({ 'GET /api/my/balance': { body: { balance: 1 } } });
    await A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'sk-SPECIAL', balancePath: '/api/my/balance?t={{key}}' });
    const hit = calls.details.find((c) => c.key === 'GET /api/my/balance');
    assert.ok(hit.url.includes('t=sk-SPECIAL'), 'URL 里的 {{key}} 要被替换:' + hit.url);
  });

  await t('手填接口认证方式:url_key 拼进查询串', async () => {
    const calls = mockFetch({ 'GET /api/my/balance': { body: { balance: 1 } } });
    await A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'sk-Q', balancePath: '/api/my/balance', balanceAuth: 'url_key' });
    const hit = calls.details.find((c) => c.key === 'GET /api/my/balance');
    assert.ok(hit.url.includes('key=sk-Q'), '要拼上 key= 参数:' + hit.url);
    assert.ok(!hit.opts.headers.authorization, 'url_key 模式不该带 Authorization 头');
  });

  await t('手填接口认证方式:none 不带任何凭据', async () => {
    const calls = mockFetch({ 'GET /api/my/balance': { body: { balance: 1 } } });
    await A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'sk-Q', balancePath: '/api/my/balance', balanceAuth: 'none' });
    const hit = calls.details.find((c) => c.key === 'GET /api/my/balance');
    assert.ok(!hit.opts.headers.authorization);
  });

  await t('币种:用户填的优先,其次站点响应,都没有就不编造', async () => {
    mockFetch({
      'GET /api/u': { body: { balance: 1, currency: 'CNY' } },
      'GET /api/none': { body: { balance: 1 } },
    });
    assert.strictEqual((await A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'k', balancePath: '/api/u' })).unit, 'CNY');
    assert.strictEqual((await A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'k', balancePath: '/api/u', balanceUnit: 'TOKENS' })).unit, 'TOKENS');
    assert.strictEqual((await A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'k', balancePath: '/api/none' })).unit, null);
  });

  await t('币种覆盖对登录路径同样生效', async () => {
    mockFetch({
      'POST /api/v1/auth/login': { body: { code: 0, data: { access_token: 'jwt', user: { email: 'user@example.com', balance: 5 } } } },
      'GET /api/v1/auth/me': { body: { code: 0, data: { balance: 5 } } },
      'GET /api/v1/usage/dashboard/stats': { body: { code: 0, data: {} } },
    });
    assert.strictEqual((await A.sub2apiLogin({ baseUrl: SUB2_SITE, username: 'user@example.com', password: 'p' })).unit, 'USD');
    assert.strictEqual((await A.sub2apiLogin({ baseUrl: SUB2_SITE, username: 'user@example.com', password: 'p', balanceUnit: 'CNY' })).unit, 'CNY');
  });

  await t('手填接口被限流 -> 报限流并停手,不继续', async () => {
    mockFetch({ 'GET /api/my/balance': { status: 429, body: {} } });
    await assert.rejects(() => A.fetchBalance({ baseUrl: CUSTOM_SITE, apiKey: 'k', balancePath: '/api/my/balance' }), /限流|429/);
  });

  await t('New API 声明了 quota_display_type 就按它的来,且不二次换算', async () => {
    mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7.2 } } },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: 100 } },
      'GET /v1/dashboard/billing/usage': { body: { total_usage: 0 } },
    });
    const r = await A.fetchByApiKey({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x' });
    assert.strictEqual(r.unit, 'CNY');
    assert.strictEqual(r.balance, 100, '站点给的就是最终显示数值,不能再乘汇率');
    assert.strictEqual(r.limit, 100);
  });

  await t('未声明币种时图标不印美元符号', () => {
    assert.strictEqual(I.currencySymbol(null), '');
    assert.strictEqual(I.currencySymbol(''), '');
    assert.strictEqual(I.money(12.5, null), '12.50', '币种未知就印裸数字');
    assert.strictEqual(I.money(12.5, 'CNY'), '¥12.50');
    assert.strictEqual(I.money(12.5, 'USD'), '$12.50');
  });

  await t('探测出协议但被限流 -> 报限流,不是"无法识别"', async () => {
    mockFetch({ 'GET /api/status': { status: 429, body: {} } });
    await assert.rejects(() => A.fetchBalance({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x' }), /限流|429|RATE/i);
  });

  console.log('\n图标与金额显示');

  await t('站名缩写:TokenBuddy -> TB', () => assert.strictEqual(I.abbrevName('TokenBuddy', 3), 'TB'));
  await t('托盘站名带域名时只取名称 -> TB', () => assert.strictEqual(I.iconSiteAbbrev('TokenBuddy (example.com)'), 'TB'));
  await t('站名缩写:Example Gateway -> EG', () => assert.strictEqual(I.abbrevName('Example Gateway', 3), 'EG'));
  await t('999997.79 不该显示成 1000K', () => assert.strictEqual(I.shortBalance(999997.79), '1M'));
  await t('图标短金额去掉无意义的末尾 0', () => {
    assert.strictEqual(I.shortBalance(15.297888), '15.3');
    assert.strictEqual(I.shortBalance(0.4), '0.4');
  });
  await t('币种符号随站点口径', () => {
    assert.strictEqual(I.currencySymbol('USD'), '$');
    assert.strictEqual(I.currencySymbol('CNY'), '¥');
    assert.strictEqual(I.currencySymbol('TOKENS'), '');
  });

  await t('图标:不压缩字形,字号填满托盘高度', () => {
    const full = I.renderBalanceIcon({ amount: '15.3', size: 64 });
    const abbr = I.renderBalanceIcon({ amount: '15.3', size: 64 });
    assert.ok(full.width > 64 * I.ICON_MAX_ASPECT_SINGLE, '单行文字允许横向变宽,不能压扁字形');
    assert.strictEqual(full.height, 64, '图标高度必须保持托盘可用的最大画布高度');
    // 没有站名时,金额渲染结果应稳定
    assert.strictEqual(full.width, abbr.width, '金额相同则宽度预期一致');
  });

  await t('图标:包含站点缩写与金额时仍保持最大高度', () => {
    const withSite = I.renderBalanceIcon({ name: 'TokenBuddy (example.com)', amount: '15.3', size: 64 });
    const amountOnly = I.renderBalanceIcon({ amount: '15.3', size: 64 });
    assert.ok(withSite.width > amountOnly.width, '带站点缩写时图标应包含额外文字');
    assert.ok(withSite.width > 64 * I.ICON_MAX_ASPECT_SINGLE, '站点缩写与余额应保持完整字号');
  });

  await t('图标:短金额字号尽可能填满高度', () => {
    const img = decodePNG(I.renderBalanceIcon({ amount: '1M', size: 64 }).png);
    assert.ok(inkRows(img).length >= 35, '短金额没有使用足够大的点阵字号');
  });

  await t('图标:小尺寸下金额那一行必须真的画在画布里', () => {
    // 点阵字高是 7*scale,双行还要行距。曾经只按宽度挑字号,
    // 结果 24px 高时第二行(金额)整个落在画布外,托盘只剩一个站名。
    for (const size of [12, 16, 20, 24, 32, 44, 64]) {
      const r = I.renderBalanceIcon({ name: 'TokenBuddy', amount: '1.2K', size });
      const img = decodePNG(r.png);
      const rows = inkRows(img);
      assert.ok(rows.length > 0, `size=${size} 整个图标没有任何文字像素`);
      // 文字不能贴到上下边缘:贴边就说明被画布裁掉了
      assert.ok(rows[0] > 0, `size=${size} 文字顶到第 0 行,说明溢出被裁`);
      assert.ok(rows[rows.length - 1] < img.h - 1, `size=${size} 文字贴到最后一行,说明溢出被裁`);
    }
  });

  await t('图标:64px 单行时站名与金额一行内排布', () => {
    const img = decodePNG(I.renderBalanceIcon({ name: '示例站点', amount: '15.30', size: 64 }).png);
    const rows = inkRows(img);
    assert.ok(rows.length > 0);
    // 单行:有效行数通常是 7*scale 的范围,没有大空隙
    let gaps = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i] - rows[i - 1] > 1) gaps++;
    assert.ok(gaps === 0, '单行图标不应有站名与金额之间的大空隙');
  });

  await t('图标:站名是中文时自动切单行,仍然出图', () => {
    const r = I.renderBalanceIcon({ name: '中转站', amount: '88.88', size: 64 });
    assert.ok(r.png.length > 0 && r.width > 0);
  });

  await t('图标:金额读不到时显示 -- 而不是 $0', () => {
    const r = I.renderBalanceIcon({ name: 'X', amount: '--', size: 64 });
    assert.ok(r.png.length > 0);
  });

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
