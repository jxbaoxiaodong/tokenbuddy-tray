'use strict';

const params = new URLSearchParams(location.search);
const VIEW = params.get('view') || 'popup';
const $ = (id) => document.getElementById(id);

function money(v, unit) {
  const sym = unit === 'CNY' ? '¥' : (unit === 'TOKENS' ? '' : '$');
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
const FW = { sub2api: 'Sub2API', newapi: 'New API' };

/* 两套架构的余额口径不同,说明文字据实写明,不做笼统承诺 */
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
    balEl.textContent = money(r.balance, u); balEl.className = 'amount';
    const bits = [];
    if (r.framework) bits.push(FW[r.framework] || r.framework);
    bits.push(active.name || '');
    if (typeof r.todayCost === 'number') bits.push('今日 ' + money(r.todayCost, u));
    else if (typeof r.used === 'number') bits.push('已用 ' + money(r.used, u));
    if (typeof r.totalCost === 'number' && r.totalCost !== r.used) bits.push('累计 ' + money(r.totalCost, u));
    if (r.unlimited) bits.push('该 Key 为无限额度,读不到真实余额,需填账号密码');
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
      <div class="field"><label>站点地址</label><input data-k="baseUrl" placeholder="https://example.com" value="${esc(site.baseUrl)}"/></div>
      <div class="field full"><label>API Key</label><input data-k="apiKey" placeholder="sk-..." value="${esc(site.apiKey)}"/></div>
      <div class="field full newapi-only" hidden>
        <label>账号</label><input data-k="username" placeholder="New API 登录用户名" value="${esc(site.username || site.email)}"/>
      </div>
      <div class="field full newapi-only" hidden>
        <label>密码</label><input data-k="password" type="password" value="${esc(site.password)}"/>
      </div>
      <div class="full why" data-why></div>
      <details class="full adv"><summary>高级</summary>
        <div class="grid" style="margin-top:10px">
          <div class="field"><label>框架(留空=按地址自动识别)</label>
            <select data-k="type">
              <option value=""${type === '' ? ' selected' : ''}>自动识别</option>
              <option value="sub2api"${type === 'sub2api' ? ' selected' : ''}>Sub2API</option>
              <option value="newapi"${type === 'newapi' ? ' selected' : ''}>New API</option>
            </select>
          </div>
          <div class="field"><label>邮箱(Sub2API 用邮箱登录)</label><input data-k="email" value="${esc(site.email)}"/></div>
          <div class="field"><label>用户 ID(New API 旧版本兜底)</label><input data-k="userId" value="${esc(site.userId)}"/></div>
          <div class="field"><label>额度换算(留空=用站点自己的设置)</label><input data-k="quotaPerUnit" placeholder="500000" value="${esc(site.quotaPerUnit)}"/></div>
        </div>
      </details>
    </div>`;
  el.querySelector('.del').onclick = () => el.remove();
  applyFramework(el, site.type === 'sub2api' ? 'sub2api' : site.type === 'newapi' ? 'newapi' : null, true);

  // 地址变了就重新识别架构(New API 才显示账号密码框)
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

/* 按识别到的架构切换界面:New API 显示账号密码并给出原因说明 */
function applyFramework(el, fw, initial) {
  el.dataset.fw = fw || '';
  const badge = el.querySelector('[data-badge]');
  const isNew = fw === 'newapi';
  for (const n of el.querySelectorAll('.newapi-only')) n.hidden = !isNew;
  el.querySelector('[data-why]').innerHTML = fw ? WHY[fw] : (initial ? '' : WHY.sub2api);
  if (!fw) {
    badge.textContent = initial ? '未检测' : '未识别(将按默认方式尝试)';
    badge.className = 'fw-badge' + (initial ? '' : ' unknown');
    return;
  }
  badge.textContent = isNew ? '已识别 New API · 需账号密码' : '已识别 Sub2API · API Key 即可';
  badge.className = 'fw-badge' + (isNew ? ' newapi' : '');
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
  await window.tb.saveConfig({ refreshSeconds: cfg.refreshSeconds, sites, activeSiteId: cfg.activeSiteId });
  $('s-status').textContent = '已保存';
  setTimeout(() => { $('s-status').textContent = ''; }, 1500);
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
  $('pet-autostart').checked = !!p.autostart;
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
  $('pet-autostart').onchange = async (e) => { await window.tb.pet.autostart(e.target.checked); };
}

async function initSettings() {
  cfg = await window.tb.getConfig();
  renderSettings();
  await initPet();
  window.tb.onGoto((sec) => { if (sec === 'pet') $('s-pet').scrollIntoView({ block: 'start' }); });
  if (params.get('section') === 'pet') $('s-pet').scrollIntoView({ block: 'start' });
}

if (VIEW === 'settings') initSettings();
else initPopup();
