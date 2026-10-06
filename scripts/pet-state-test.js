// 桌面宠物状态机测试:在真实 Electron DOM 里跑 src/pet/pet.js,验证 9 种形象切换
const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function makeSnap(o) {
  return Object.assign({
    refreshing: false,
    activeSiteId: 's1',
    sites: [{ id: 's1', name: '示例站点' }],
    active: null,
  }, o);
}

const CASES = [
  ['余额正常',        makeSnap({ active: { balance: 15.29, unit: 'CNY' } }),                  'balance',    '01.png'],
  ['余额为 0',        makeSnap({ active: { balance: 0, unit: 'CNY' } }),                      'empty',      '02.png'],
  ['余额偏低 <=1',    makeSnap({ active: { balance: 0.4, unit: 'USD' } }),                    'low',        '03.png'],
  ['无限额度',        makeSnap({ active: { unlimited: true } }),                             'unlimited',  '09.png'],
  ['余额读不到',      makeSnap({ active: { balance: null, unit: 'CNY' } }),                    'unknown',    '08.png'],
  ['读取失败',        makeSnap({ active: { error: 'timeout' } }),                            'error',      '06.png'],
  ['刷新中(无数据)',  makeSnap({ refreshing: true }),                                       'refreshing', '05.png'],
  ['无快照',          makeSnap({}),                                                          'refreshing', '05.png'],
  ['后台刷新(有余额)', makeSnap({ refreshing: true, active: { balance: 15.29, unit: 'CNY' } }), 'balance',  '01.png'],
];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 420, show: false,
    webPreferences: { preload: path.join(ROOT, 'scripts', 'pet-test-preload.js'), contextIsolation: true },
  });

  await win.loadFile(path.join(ROOT, 'src', 'pet', 'pet.html'));

  const failures = [];
  let pass = 0;

  // 逐个状态:注入快照,读回实际使用的素材文件名
  for (const [label, snap, , expectedFile] of CASES) {
    const actual = await win.webContents.executeJavaScript(`(() => {
      const img = document.getElementById('media');
      // 直接调用页面里的 updateSnapshot(通过 onUpdate 回调已注册,这里复用 window.__snap)
      window.tb.__pushSnap(${JSON.stringify(snap)});
      const src = img.getAttribute('src') || '';
      return {
        file: src.split('/').pop(),
        visible: !img.classList.contains('hidden'),
        bubbleName: document.getElementById('bubbleName').textContent,
        bubbleText: document.getElementById('bubbleText').textContent,
      };
    })()`);
    if (actual.file === expectedFile && actual.visible) {
      console.log(`  ✓ ${label.padEnd(18)} -> ${actual.file}   气泡「${actual.bubbleName} ${actual.bubbleText}」`);
      pass++;
    } else {
      console.log(`  ✗ ${label.padEnd(18)} 期望 ${expectedFile} 实际 ${actual.file} (可见=${actual.visible})`);
      failures.push(label);
    }
  }

  // 交互表情优先于余额表情
  for (const [label, file, script] of [
    ['单击表情', '04.png', `document.dispatchEvent(new MouseEvent('mousedown',{button:0,screenX:100,screenY:100,bubbles:true}));
                            document.dispatchEvent(new MouseEvent('mouseup',{button:0,screenX:100,screenY:100,bubbles:true}));`],
    ['拖动表情', '07.png', `document.dispatchEvent(new MouseEvent('mousedown',{button:0,screenX:100,screenY:100,bubbles:true}));
                            document.dispatchEvent(new MouseEvent('mousemove',{screenX:160,screenY:140,bubbles:true}));`],
  ]) {
    await win.webContents.executeJavaScript(`window.tb.__pushSnap(${JSON.stringify(makeSnap({ active: { balance: 15.29, unit: 'CNY' } }))});`);
    await win.webContents.executeJavaScript(script);
    await new Promise((r) => setTimeout(r, 400));
    const actual = await win.webContents.executeJavaScript(
      `(document.getElementById('media').getAttribute('src')||'').split('/').pop()`
    );
    if (actual === file) { console.log(`  ✓ ${label.padEnd(18)} -> ${actual}`); pass++; }
    else { console.log(`  ✗ ${label.padEnd(18)} 期望 ${file} 实际 ${actual}`); failures.push(label); }
  }

  // 素材文件是否真实可加载(不只看文件名)
  const loadReport = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    for (let i = 1; i <= 9; i++) {
      const f = '0' + i + '.png';
      const ok = await new Promise((res) => {
        const t = new Image();
        t.onload = () => res({ ok: true, w: t.naturalWidth, h: t.naturalHeight });
        t.onerror = () => res({ ok: false });
        t.src = '../../assets/pet/' + f;
      });
      out.push({ f, ...ok });
    }
    return out;
  })()`);
  for (const r of loadReport) {
    if (r.ok && r.w === 512 && r.h === 512) { console.log(`  ✓ 素材 ${r.f} 可加载 ${r.w}x${r.h}`); pass++; }
    else { console.log(`  ✗ 素材 ${r.f} 加载失败或尺寸异常: ${JSON.stringify(r)}`); failures.push('asset ' + r.f); }
  }

  // 自定义素材时不应被状态切换覆盖
  await win.webContents.executeJavaScript(`window.tb.__pushSnap(${JSON.stringify(makeSnap({ active: { balance: 0, unit: 'CNY' } }))});`);
  const customKept = await win.webContents.executeJavaScript(`(() => {
    window.tb.__reload({ size: 200, opacity: 1, flip: false, showBalance: true, mediaType: 'image',
                      asset: { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' } });
    const src = document.getElementById('media').getAttribute('src') || '';
    return src.startsWith('data:image/gif');
  })()`);
  if (customKept) { console.log('  ✓ 自定义素材不被状态切换覆盖'); pass++; }
  else { console.log('  ✗ 自定义素材被状态切换覆盖'); failures.push('custom asset'); }

  console.log(`\n全部通过: ${pass} 通过, ${failures.length} 失败`);
  if (failures.length) console.log('失败项: ' + failures.join(', '));
  app.exit(failures.length ? 1 : 0);
});
