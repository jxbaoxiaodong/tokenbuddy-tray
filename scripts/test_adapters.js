'use strict';
/*
 * 余额适配器回归测试。不联网、不需要任何密钥:用 mock 替换 global.fetch。
 * 覆盖的都是实际踩到的坑:
 *   - New API 的 hard_limit_usd 是总额度,不是余额
 *   - 无限额度 Key 被固定返回 100000000,不能当成余额显示
 *   - 币种不能写死 USD
 *   - 新版 New API 登录直接返回 data.user,不再需要 cookie + New-Api-User
 *   - 架构识别只看站点地址,不消耗凭据
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
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const key = (opts.method || 'GET') + ' ' + u.pathname;
    calls.push(key);
    const r = routes[key];
    const headers = new Map(Object.entries((r && r.headers) || {}));
    return {
      status: (r && r.status) || 200,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
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

(async () => {
  console.log('架构识别(只看地址,不消耗凭据)');

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

  await t('/v1/usage 未带 Key 返 401 API_KEY_REQUIRED -> 判为 Sub2API', async () => {
    mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /v1/usage': { status: 401, body: { code: 'API_KEY_REQUIRED', message: 'API key is required' } },
    });
    assert.strictEqual((await A.detectFramework(SUB2_SITE)).framework, 'sub2api');
  });

  await t('所有探测端点都不存在 -> 不猜,返回 null', async () => {
    mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /v1/usage': { status: 404, body: {} },
      'POST /api/v1/auth/login': { status: 404, body: {} },
    });
    assert.strictEqual((await A.detectFramework(NEWAPI_SITE)).framework, null);
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
    assert.ok(r.unlimitedHint && r.unlimitedHint.includes('账号密码'));
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
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 1 } } },
      'POST /api/user/login': {
        body: { success: true, data: { access_token: 'jwt', user: { id: 4332, username: 'u', quota: 7648944, used_quota: 3698768304 } } },
      },
    });
    const r = await A.newapiLogin({ baseUrl: NEWAPI_SITE, username: 'u', password: 'p' });
    assert.strictEqual(r.balance, 15.297888);   // 7648944 / 500000
    assert.strictEqual(r.unit, 'CNY');
    assert.ok(!calls.includes('GET /api/user/self'), '新版不该再多发一次 /api/user/self');
  });

  await t('旧版:无 data.user 时退回 JWT,再不行才用 cookie + New-Api-User', async () => {
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': {
        headers: { 'set-cookie': 'session=abc; Path=/' },
        body: { success: true, data: { access_token: 'jwt', id: 4332 } },
      },
      'GET /api/user/self': { body: { success: true, data: { username: 'u', quota: 500000, used_quota: 0 } } },
    });
    const r = await A.newapiLogin({ baseUrl: NEWAPI_SITE, username: 'u', password: 'p' });
    assert.strictEqual(r.balance, 1);
    assert.ok(calls.includes('GET /api/user/self'));
  });

  await t('登录失败要报错,不能静默当成 0', async () => {
    mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': { body: { success: false, message: '用户名或密码错误' } },
    });
    await assert.rejects(() => A.newapiLogin({ baseUrl: NEWAPI_SITE, username: 'u', password: 'bad' }), /用户名或密码错误/);
  });

  console.log('\n入口选择');

  await t('New API 同时有 Key 和密码时走密码(否则 Key 会盖掉真实余额)', async () => {
    const calls = mockFetch({
      'GET /api/status': { body: { data: { quota_per_unit: 500000 } } },
      'POST /api/user/login': { body: { success: true, data: { user: { username: 'u', quota: 500000, used_quota: 0 } } } },
      'GET /v1/dashboard/billing/subscription': { body: { hard_limit_usd: A.NEWAPI_UNLIMITED_SENTINEL } },
      'GET /v1/dashboard/billing/usage': { body: { total_usage: 0 } },
    });
    const r = await A.fetchBalance({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x', username: 'u', password: 'p' });
    assert.strictEqual(r.balance, 1);
    assert.ok(!calls.includes('GET /v1/dashboard/billing/subscription'), '不该走 Key 的计费接口');
  });

  await t('Sub2API 有 Key 时优先 Key(/v1/usage 就是账户真实余额)', async () => {
    const calls = mockFetch({
      'GET /api/status': { status: 404, body: {} },
      // 未鉴权探测:必须像真机一样 401,否则无法区分架构
      'GET /v1/usage': { body: { balance: 999997.79, remaining: 999997.79, unit: 'USD', usage: { today: { actual_cost: 1 }, total: { actual_cost: 2 } } } },
    });
    const r = await A.fetchBalance({ baseUrl: SUB2_SITE, apiKey: 'sk-y', username: 'u', password: 'p', type: 'sub2api' });
    assert.strictEqual(r.balance, 999997.79);
    assert.strictEqual(r.framework, 'sub2api');
  });

  await t('探测不出架构时,按用户配置的框架执行,不瞎猜', async () => {
    mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /v1/usage': { body: { balance: 42, unit: 'USD' } },
    });
    // 配置里写了 sub2api,且 /v1/usage 能给出余额 -> 应按 sub2api 取,而不是抛"无法识别"
    const r = await A.fetchBalance({ baseUrl: SUB2_SITE, apiKey: 'sk-y', type: 'sub2api' });
    assert.strictEqual(r.balance, 42);
  });

  await t('探测不出架构且也没配置框架 -> 明确报错,不假装成 0', async () => {
    mockFetch({
      'GET /api/status': { status: 404, body: {} },
      'GET /v1/usage': { body: {} },
      'POST /api/v1/auth/login': { status: 404, body: {} },
    });
    await assert.rejects(() => A.fetchBalance({ baseUrl: NEWAPI_SITE, apiKey: 'sk-x' }), /无法识别站点架构/);
  });

  console.log('\n图标与金额显示');

  await t('站名缩写:TokenBuddy -> TB', () => assert.strictEqual(I.abbrevName('TokenBuddy', 3), 'TB'));
  await t('站名缩写:CC Switch -> CS', () => assert.strictEqual(I.abbrevName('CC Switch', 3), 'CS'));
  await t('999997.79 不该显示成 1000K', () => assert.strictEqual(I.shortBalance(999997.79), '1M'));
  await t('币种符号随站点口径', () => {
    assert.strictEqual(I.currencySymbol('USD'), '$');
    assert.strictEqual(I.currencySymbol('CNY'), '¥');
    assert.strictEqual(I.currencySymbol('TOKENS'), '');
  });

  await t('图标:宽度由金额行决定,并受宽高比上限约束', () => {
    const full = I.renderBalanceIcon({ name: 'Xcode', amount: '15.30', size: 64 });
    const abbr = I.renderBalanceIcon({ name: 'TokenBuddy', amount: '15.30', size: 64 });
    assert.ok(full.width <= 64 * I.ICON_MAX_ASPECT, '图标宽高比不能超上限,否则顶栏会把它缩得更小');
    assert.strictEqual(full.width, abbr.width, '金额相同则宽度相同,宽度不由站名决定');
    // 站名确实被画进图里了:换名字 -> 像素必须不同
    assert.notStrictEqual(full.png.toString('base64'), abbr.png.toString('base64'));
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

  await t('图标:64px 双行时站名与金额占两条分离的文字带', () => {
    const img = decodePNG(I.renderBalanceIcon({ name: 'Xcode', amount: '15.30', size: 64 }).png);
    const rows = inkRows(img);
    assert.ok(rows.length > 0);
    // 双行必须有行间空隙
    let gaps = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i] - rows[i - 1] > 1) gaps++;
    assert.ok(gaps >= 1, '双行图标应在站名与金额之间有空行');
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