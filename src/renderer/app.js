'use strict';

const params = new URLSearchParams(location.search);
const VIEW = params.get('view') || 'popup';
const $ = (id) => document.getElementById(id);

function money(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '$—';
  if (v !== 0 && Math.abs(v) < 1) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}
function ago(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  return Math.floor(s / 3600) + ' 小时前';
}

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
  const balEl = $('p-balance');
  const subEl = $('p-sub');
  const stEl = $('p-status');

  if (!active) {
    balEl.textContent = '$—'; balEl.className = 'amount';
    subEl.textContent = '还没有配置任何站点';
    stEl.textContent = '';
  } else if (r && r.error) {
    balEl.textContent = '读取失败'; balEl.className = 'amount err';
    subEl.textContent = r.error;
    stEl.textContent = ago(r.at);
  } else if (r) {
    balEl.textContent = money(r.balance); balEl.className = 'amount';
    const bits = [];
    if (typeof r.todayCost === 'number') bits.push('今日 ' + money(r.todayCost));
    if (typeof r.used === 'number') bits.push('已用 ' + money(r.used));
    if (typeof r.totalCost === 'number') bits.push('累计 ' + money(r.totalCost));
    subEl.textContent = bits.join(' · ') || (r.name || '');
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
  const type = site.type || 'sub2api';
  const cred = type === 'newapi'
    ? `<div class="field"><label>用户名</label><input data-k="username" value="${esc(site.username)}"/></div>
       <div class="field"><label>密码</label><input data-k="password" type="password" value="${esc(site.password)}"/></div>
       <div class="field"><label>访问令牌(可选,优先)</label><input data-k="accessToken" value="${esc(site.accessToken)}"/></div>
       <div class="field"><label>用户 ID(可选)</label><input data-k="userId" value="${esc(site.userId)}"/></div>
       <div class="field full hint">New API 余额 = quota ÷ 500000。密码模式会自动登录取 session;填了访问令牌则优先用令牌。</div>`
    : `<div class="field"><label>邮箱</label><input data-k="email" value="${esc(site.email)}"/></div>
       <div class="field"><label>密码</label><input data-k="password" type="password" value="${esc(site.password)}"/></div>`;
  el.innerHTML = `
    <div class="site-head">
      <span class="title">${esc(site.name || '新站点')}</span>
      <button class="del">删除</button>
    </div>
    <div class="grid">
      <div class="field"><label>名称</label><input data-k="name" value="${esc(site.name)}"/></div>
      <div class="field"><label>框架</label>
        <select data-k="type">
          <option value="sub2api"${type === 'sub2api' ? ' selected' : ''}>Sub2API(本站)</option>
          <option value="newapi"${type === 'newapi' ? ' selected' : ''}>New API</option>
        </select>
      </div>
      <div class="field full"><label>站点地址</label><input data-k="baseUrl" placeholder="https://example.com" value="${esc(site.baseUrl)}"/></div>
      ${cred}
    </div>`;
  el.querySelector('.del').onclick = () => el.remove();
  el.querySelector('[data-k="type"]').onchange = (e) => {
    const cur = {};
    el.querySelectorAll('[data-k]').forEach((inp) => { cur[inp.dataset.k] = inp.value; });
    el.replaceWith(siteCard(Object.assign({}, cur, { type: e.target.value, id: el.dataset.id })));
  };
  return el;
}
function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function renderSettings() {
  $('settings').classList.remove('hidden');
  $('s-interval').value = cfg.refreshSeconds || 120;
  const wrap = $('s-sites');
  wrap.innerHTML = '';
  (cfg.sites || []).forEach((s) => wrap.appendChild(siteCard(s)));
  $('s-add').onclick = () => wrap.appendChild(siteCard({ type: 'sub2api', name: '新站点' }));
  $('s-save').onclick = saveSettings;
}

async function saveSettings() {
  const sites = [];
  document.querySelectorAll('.site').forEach((el) => {
    const o = { id: el.dataset.id || undefined };
    el.querySelectorAll('[data-k]').forEach((inp) => { o[inp.dataset.k] = inp.value.trim(); });
    if (o.baseUrl) sites.push(o);
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

async function initSettings() {
  cfg = await window.tb.getConfig();
  renderSettings();
}

if (VIEW === 'settings') initSettings();
else initPopup();
