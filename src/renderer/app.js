'use strict';

const params = new URLSearchParams(location.search);
const VIEW = params.get('view') || 'popup';
const $ = (id) => document.getElementById(id);

function money(v, unit) {
  // 站点没声明币种时印裸数字,不编造 "$"
  const sym = unit == null || unit === '' ? '' : (unit === 'CNY' ? '¥' : (unit === 'TOKENS' ? '' : '$'));
  if (typeof v !== 'number' || !isFinite(v)) return sym + '—';
  if (v !== 0 && Math.abs(v) < 1) return sym + v.toFixed(4);
  return sym + v.toFixed(2);
}
function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function ago(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  return Math.floor(s / 3600) + ' 小时前';
}
const FW = {
  sub2api: 'Sub2API', newapi: 'New API', dedicated: '专用站点适配',
  probe: '能力探测', custom: '自定义接口',
};
function fwLabel(r) {
  if (!r) return '';
  if (r.framework === 'probe') return '能力探测 · ' + (r.probeLabel || r.probeProtocol || '');
  if (r.framework === 'custom') return '自定义接口 · ' + (r.customField || '');
  return FW[r.framework] || r.framework || '';
}

/* 各协议的余额口径不同,说明文字据实写明,不做笼统承诺 */
const WHY = {
  newapi: `<b>New API 为什么必须登录</b>
    <p>API Key 只能查到<b>这把 Key 自己的额度</b>,不是账户余额:</p>
    <ul>
      <li><code>/v1/dashboard/billing/subscription</code> 返回的 <code>hard_limit_usd</code> 是「剩余 + 已用」合计的<b>总额度</b>;</li>
      <li>若这把 Key 是<b>无限额度</b>,New API 会把它固定返回成 <code>100000000</code> 这个占位数字,永远不给真实余额。</li>
    </ul>
    <p>账户真实余额只存在登录用户的 <code>quota</code> 字段里,所以下面必须填账号密码。登录走纯 HTTP 请求,不启动浏览器。</p>`,
  sub2api: `<b>Sub2API 不需要登录</b>
    <p><code>/v1/usage</code> 直接返回账户钱包的真实剩余余额,一把 API Key 就够。账号密码只在站点关闭该接口时才需要。</p>`,
  dedicated: `<b>此站点使用专用账户会话</b>
    <p>程序登录一次后通过账户接口读取真实余额，并把登录令牌安全保存在本机。定时刷新只复用令牌，不会反复登录。</p>`,
  probe: `<b>这个站点没认出来,改用能力探测</b>
    <p>地址探测没匹配到已知协议,于是拿你的 API Key 依次试下面几个余额接口,<b>谁返回合法余额就用谁</b>:</p>
    <ul>
      <li><code>/v1/usage</code> · <code>/v1/dashboard/billing/*</code> · <code>/api/v1/auth/me</code> · <code>/api/usage/token/</code> · <code>/api/user/self</code></li>
    </ul>
    <p>命中的是哪个接口会如实显示在徽章和面板上,<b>不会冒充成 Sub2API 或 New API</b>。首次命中后协议会记住,之后不再重复试探。</p>
    <p>如果探测也读不到,就在下面<b>手填余额接口路径</b>。</p>`,
  custom: `<b>使用你手填的余额接口</b>
    <p>填了「余额接口路径」就以它为准:<b>不做协议识别、不做能力探测</b>。</p>
    <p>查询失败会如实报出 HTTP 状态和响应内容,<b>不会偷偷换别的接口</b>。</p>`,
};

/* ============================ 托盘弹窗 ============================ */
let snap = { results: {}, sites: [], activeSiteId: null, refreshing: false };

function renderPopup() {
  const sel = $('p-site');
  sel.innerHTML = '';
  for (const s of snap.sites) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.name;
    if (s.id === snap.activeSiteId) o.selected = true;
    sel.appendChild(o);
  }
  sel.style.display = snap.sites.length > 1 ? '' : 'none';

  const active = snap.sites.find((s) => s.id === snap.activeSiteId) || snap.sites[0];
  const r = active ? snap.results[active.id] : null;
  const balEl = $('p-balance'), subEl = $('p-sub'), stEl = $('p-status');

  if (!active) {
    balEl.textContent = '$—'; balEl.className = 'amount';
    subEl.textContent = '还没有配置站点,点「配置站点」开始';
    stEl.textContent = '';
  } else if (r && r.error) {
    balEl.textContent = '读取失败'; balEl.className = 'amount err';
    subEl.textContent = r.error;
    stEl.textContent = ago(r.at);
  } else if (r) {
    const u = r.unit;
    balEl.textContent = r.unlimited ? '无限' : money(r.balance, u); balEl.className = 'amount';
    const bits = [];
    const fl = fwLabel(r);
    if (fl) bits.push(fl);
    bits.push(active.name || '');
    if (typeof r.todayCost === 'number') bits.push('今日 ' + money(r.todayCost, u));
    else if (typeof r.used === 'number') bits.push('已用 ' + money(r.used, u));
    if (typeof r.totalCost === 'number' && r.totalCost !== r.used) bits.push('累计 ' + money(r.totalCost, u));
    if (r.unlimited) bits.push('该 Key 为无限额度 · 站点未提供数字余额');
    subEl.textContent = bits.filter(Boolean).join(' · ');
    stEl.textContent = snap.refreshing ? '刷新中…' : ago(r.at);
  } else {
    balEl.textContent = '$—'; balEl.className = 'amount';
    subEl.textContent = snap.refreshing ? '读取中…' : '';
    stEl.textContent = '';
  }
}

function initPopup() {
  $('popup').classList.remove('hidden');
  $('p-refresh').onclick = () => window.tb.refresh();
  $('p-gear').onclick = () => window.tb.openSettings();
  $('p-settings').onclick = () => window.tb.openSettings();
  $('p-quit').onclick = (e) => { e.preventDefault(); window.tb.quit(); };
  $('p-site').onchange = (e) => window.tb.setActive(e.target.value);
  window.tb.getSnapshot().then((s) => { snap = s; renderPopup(); });
  window.tb.onUpdate((s) => { snap = s; renderPopup(); });
}

/* ============================ 设置窗口 ============================ */
let cfg = { refreshSeconds: 120, sites: [] };

function siteCard(site) {
  const el = document.createElement('div');
  el.className = 'site';
  el.dataset.id = site.id || '';
  const type = site.type || '';
  el.innerHTML = `
    <div class="site-head">
      <span class="title">${esc(site.name || '新站点')}</span>
      <span class="fw-badge" data-badge>未检测</span>
      <button class="del">删除</button>
    </div>
    <div class="grid">
      <div class="field"><label>名称</label><input data-k="name" value="${esc(site.name)}"/></div>
      <div class="field"><label>API Key 的 BASE URL</label><input data-k="baseUrl" placeholder="https://api.example.com/v1" value="${esc(site.baseUrl)}"/></div>
      <div class="field full"><label>API Key</label><input data-k="apiKey" placeholder="sk-..." value="${esc(site.apiKey)}"/></div>
      <div class="field full account-only" hidden>
        <label>账号</label><input data-k="username" placeholder="登录用户名或邮箱" value="${esc(site.username || site.email)}"/>
      </div>
      <div class="field full account-only" hidden>
        <label>密码</label><input data-k="password" type="password" value="${esc(site.password)}"/>
      </div>
      <div class="full why" data-why></div>
      <details class="full adv"><summary>高级</summary>
        <div class="grid" style="margin-top:10px">
          <div class="field"><label>协议(留空=按 BASE URL 自动识别)</label>
            <select data-k="type">
              <option value=""${type === '' ? ' selected' : ''}>自动识别</option>
              <option value="sub2api"${type === 'sub2api' ? ' selected' : ''}>Sub2API</option>
              <option value="newapi"${type === 'newapi' ? ' selected' : ''}>New API</option>
              <option value="dedicated"${type === 'dedicated' ? ' selected' : ''}>专用站点适配</option>
              <option value="probe"${type === 'probe' ? ' selected' : ''}>能力探测(依次试已知接口)</option>
              <option value="custom"${type === 'custom' ? ' selected' : ''}>自定义接口(下方填路径)</option>
            </select>
          </div>
          <div class="field"><label>邮箱(Sub2API 用邮箱登录)</label><input data-k="email" value="${esc(site.email)}"/></div>
          <div class="field"><label>用户 ID(New API 旧版本兜底)</label><input data-k="userId" value="${esc(site.userId)}"/></div>
          <div class="field"><label>额度换算(留空=用站点自己的设置)</label><input data-k="quotaPerUnit" placeholder="500000" value="${esc(site.quotaPerUnit)}"/></div>
          <div class="field full"><label>能力探测已命中的协议(只读,程序自动记住;清空可重新探测)</label>
            <input data-k="probeProtocol" value="${esc(site.probeProtocol)}" placeholder="还没有探测命中"/></div>
        </div>
        <div class="grid" style="margin-top:12px">
          <div class="field full"><label>余额接口路径(填了就以它为准:不识别协议、不做探测。可用 {{key}} 代表 API Key)</label>
            <input data-k="balancePath" placeholder="/api/custom/balance?key={{key}}" value="${esc(site.balancePath)}"/></div>
          <div class="field"><label>余额字段(留空=只找顶层 balance / remaining / quota)</label>
            <input data-k="balanceField" placeholder="data.balance" value="${esc(site.balanceField)}"/></div>
          <div class="field"><label>余额接口认证</label>
            <select data-k="balanceAuth">
              <option value="bearer"${site.balanceAuth === 'bearer' || !site.balanceAuth ? ' selected' : ''}>Bearer API Key</option>
              <option value="url_key"${site.balanceAuth === 'url_key' ? ' selected' : ''}>URL 参数 key=</option>
              <option value="none"${site.balanceAuth === 'none' ? ' selected' : ''}>不需要认证</option>
            </select>
          </div>
          <div class="field"><label>币种(留空=按站点响应,都不给就不印符号)</label>
            <input data-k="balanceUnit" placeholder="USD / CNY / TOKENS" value="${esc(site.balanceUnit)}"/></div>
          <div class="field full">
            <button class="btn" data-test>测试自定义接口</button>
            <span class="status" data-test-out></span>
          </div>
        </div>
      </details>
    </div>`;
  el.querySelector('.del').onclick = () => el.remove();
  el.querySelector('[data-test]').onclick = async (e) => {
    const out = el.querySelector('[data-test-out]');
    const read = (k) => { const n = el.querySelector('[data-k="' + k + '"]'); return n ? n.value.trim() : ''; };
    out.textContent = '测试中…'; out.className = 'status';
    try {
      const r = await window.tb.testEndpoint({
        baseUrl: read('baseUrl'), apiKey: read('apiKey'),
        balancePath: read('balancePath'), balanceField: read('balanceField'),
        balanceAuth: read('balanceAuth'), balanceUnit: read('balanceUnit'),
      });
      out.textContent = '成功:' + r.summary;
      out.className = 'status ok';
    } catch (err) {
      out.textContent = '失败:' + (err && err.message ? err.message : String(err));
      out.className = 'status err';
    }
  };
  applyFramework(el, ['sub2api', 'newapi', 'dedicated', 'probe', 'custom'].includes(site.type) ? site.type : null, true);

  // 地址变了就重新识别协议(New API 与专用站点适配才显示账号密码框)
  const url = el.querySelector('[data-k="baseUrl"]');
  let timer = null;
  const recheck = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = url.value.trim();
      if (!v) return applyFramework(el, null, false);
      el.querySelector('[data-badge]').textContent = '检测中…';
      el.querySelector('[data-badge]').className = 'fw-badge pending';
      const d = await window.tb.detect(v);
      applyFramework(el, d ? d.framework : null, false);
    }, 500);
  };
  url.addEventListener('input', recheck);
  url.addEventListener('blur', recheck);
  return el;
}

/* 按识别到的协议切换界面:需要登录的站点显示账号密码并给出原因说明 */
function applyFramework(el, fw, initial) {
  el.dataset.fw = fw || '';
  const badge = el.querySelector('[data-badge]');
  const needsAccount = fw === 'newapi' || fw === 'dedicated';
  for (const n of el.querySelectorAll('.account-only')) n.hidden = !needsAccount;
  el.querySelector('[data-why]').innerHTML = fw ? WHY[fw] : (initial ? '' : WHY.sub2api);
  if (!fw) {
    badge.textContent = initial ? '未检测' : '未识别(保存后用能力探测依次试已知接口)';
    badge.className = 'fw-badge' + (initial ? '' : ' unknown');
    return;
  }
  badge.textContent =
    fw === 'newapi' ? '已识别 New API · 需账号密码'
      : fw === 'dedicated' ? '已识别专用站点 · 需账号密码'
        : fw === 'probe' ? '能力探测模式 · API Key 即可'
          : fw === 'custom' ? '自定义接口 · 以上方填的路径为准'
            : '已识别 Sub2API · API Key 即可';
  badge.className = 'fw-badge' + (needsAccount ? ' newapi' : (fw === 'probe' || fw === 'custom' ? ' unknown' : ''));
}

function renderSettings() {
  $('settings').classList.remove('hidden');
  $('s-interval').value = cfg.refreshSeconds || 120;
  const wrap = $('s-sites');
  wrap.innerHTML = '';
  (cfg.sites || []).forEach((s) => wrap.appendChild(siteCard(s)));
  $('s-add').onclick = () => wrap.appendChild(siteCard({ name: '新站点' }));
  $('s-save').onclick = saveSettings;
}

async function saveSettings() {
  const sites = [];
  document.querySelectorAll('.site').forEach((el) => {
    const o = { id: el.dataset.id || undefined };
    el.querySelectorAll('[data-k]').forEach((inp) => { o[inp.dataset.k] = inp.value.trim(); });
    // 只有 Sub2API 才用邮箱登录;旧配置把邮箱填在 username 里,这里搬回 email。
    // New API 的 username 是登录账号,不能当成邮箱,否则两边字段都被污染。
    if (o.type !== 'newapi' && o.username && !o.email) o.email = o.username;
    if (o.baseUrl && (o.apiKey || o.password)) sites.push(o);
  });
  cfg.sites = sites;
  cfg.refreshSeconds = Number($('s-interval').value) || 120;
  if (!cfg.activeSiteId || !sites.some((s) => s.id === cfg.activeSiteId)) {
    cfg.activeSiteId = (sites[0] && sites[0].id) || null;
  }
  $('s-status').textContent = '保存中…';
  try {
    cfg = await window.tb.saveConfig({ refreshSeconds: cfg.refreshSeconds, sites, activeSiteId: cfg.activeSiteId });
    const latest = await window.tb.getSnapshot();
    const active = latest.sites.find((s) => s.id === latest.activeSiteId) || latest.sites[0];
    const result = active && latest.results[active.id];
    if (result && result.error) {
      $('s-status').textContent = '已保存，但余额读取失败：' + result.error;
      return;
    }
    $('s-status').textContent = '已保存并读取成功';
    setTimeout(() => { $('s-status').textContent = ''; }, 1800);
  } catch (e) {
    $('s-status').textContent = '保存失败：' + (e && e.message ? e.message : String(e));
  }
}

/* ---------------------------- 顶栏余额条设置 ---------------------------- */
let barStyle = null;

function refreshBarUI() {
  const b = barStyle || {};
  const enabled = !!(b.enabled);
  $('bar-enabled').checked = enabled;
  const scale = Number(b.scale) || 1;
  $('bar-scale').value = scale;
  $('bar-scale-val').textContent = Math.round(scale * 100) + '%';
  const radius = Number(b.radius);
  $('bar-radius').value = radius == null || isNaN(radius) ? 22 : radius;
  $('bar-radius-val').textContent = (radius == null || isNaN(radius) ? 22 : radius) + ' px';
  $('bar-abbrev').value = b.abbrev || '';
  $('bar-fg-color').value = b.fgColor || '#34d399';
  $('bar-bg-color').value = b.bgColor || '#0d1421';
}

async function initBar() {
  barStyle = await window.tb.bar.get();
  refreshBarUI();
  $('bar-enabled').onchange = (e) => { barStyle.enabled = e.target.checked; window.tb.saveConfig({ balanceBar: { ...barStyle } }); };
  $('bar-scale').oninput = (e) => { $('bar-scale-val').textContent = Math.round(Number(e.target.value) * 100) + '%'; };
  $('bar-scale').onchange = (e) => { barStyle.scale = Number(e.target.value); window.tb.saveConfig({ balanceBar: { ...barStyle } }); };
  $('bar-radius').oninput = (e) => { $('bar-radius-val').textContent = e.target.value + ' px'; };
  $('bar-radius').onchange = (e) => { barStyle.radius = Number(e.target.value); window.tb.saveConfig({ balanceBar: { ...barStyle } }); };
  $('bar-abbrev').onchange = (e) => { barStyle.abbrev = e.target.value.trim(); window.tb.saveConfig({ balanceBar: { ...barStyle } }); };
  $('bar-fg-color').onchange = (e) => { barStyle.fgColor = e.target.value; window.tb.saveConfig({ balanceBar: { ...barStyle } }); };
  $('bar-bg-color').onchange = (e) => { barStyle.bgColor = e.target.value; window.tb.saveConfig({ balanceBar: { ...barStyle } }); };
  $('bar-bg-reset').onclick = () => { barStyle.bgColor = ''; refreshBarUI(); window.tb.saveConfig({ balanceBar: { ...barStyle } }); };
  $('bar-fg-reset').onclick = () => { barStyle.fgColor = ''; refreshBarUI(); window.tb.saveConfig({ balanceBar: { ...barStyle } }); };
}

/* ---------------------------- 桌面宠物设置 ---------------------------- */
let petState = null;

function petName(p) {
  if (p.asset && p.asset.name) return p.asset.name;
  if (p.assetPath) return p.assetPath.split(/[\\/]/).pop();
  return '使用内置吉祥物';
}
function refreshPetUI() {
  const p = petState || {};
  $('pet-enabled').checked = !!p.enabled;
  $('pet-asset-name').textContent = petName(p);
  $('pet-size').value = p.size || 200;
  $('pet-size-val').textContent = (p.size || 200) + ' px';
  $('pet-opacity').value = p.opacity == null ? 1 : p.opacity;
  $('pet-opacity-val').textContent = Math.round((p.opacity == null ? 1 : p.opacity) * 100) + '%';
  $('pet-show-balance').checked = p.showBalance !== false;
  $('pet-ontop').checked = !!p.alwaysOnTop;
  $('pet-flip').checked = !!p.flip;
}
async function petSet(patch) { petState = await window.tb.pet.set(patch); refreshPetUI(); }

async function initPet() {
  petState = await window.tb.pet.get();
  refreshPetUI();
  $('pet-enabled').onchange = (e) => petSet({ enabled: e.target.checked });
  $('pet-choose').onclick = async () => { const r = await window.tb.pet.choose(); if (r) { petState = r; refreshPetUI(); } };
  $('pet-reset').onclick = () => petSet({ assetPath: '', mediaType: 'image', enabled: true });
  $('pet-size').oninput = (e) => { $('pet-size-val').textContent = e.target.value + ' px'; };
  $('pet-size').onchange = (e) => petSet({ size: Number(e.target.value) });
  $('pet-opacity').oninput = (e) => { $('pet-opacity-val').textContent = Math.round(Number(e.target.value) * 100) + '%'; };
  $('pet-opacity').onchange = (e) => petSet({ opacity: Number(e.target.value) });
  $('pet-show-balance').onchange = (e) => petSet({ showBalance: e.target.checked });
  $('pet-ontop').onchange = (e) => petSet({ alwaysOnTop: e.target.checked });
  $('pet-flip').onchange = (e) => petSet({ flip: e.target.checked });
}

async function initSettings() {
  cfg = await window.tb.getConfig();
  renderSettings();
  await initBar();
  await initPet();
  window.tb.onGoto((sec) => { if (sec === 'pet') $('s-pet').scrollIntoView({ block: 'start' }); if (sec === 'bar') $('s-bar').scrollIntoView({ block: 'start' }); });
  if (params.get('section') === 'pet') $('s-pet').scrollIntoView({ block: 'start' });
  if (params.get('section') === 'bar') $('s-bar').scrollIntoView({ block: 'start' });
}

if (VIEW === 'settings') initSettings();
else initPopup();
