/* Real-browser smoke/regression checks. No npm dependencies; uses Chrome DevTools Protocol. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = process.env.QA_DIR || path.join(os.tmpdir(), 'mood-diary-qa');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-diary-chrome-'));
const port = Number(process.env.CDP_PORT || 9333);
const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.endsWith('favicon.ico')) { res.writeHead(204); return res.end(); }
  const relative = decodeURIComponent(url.pathname).replace(/^\/mood-diary\/?/, '') || 'index.html';
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  const ext = path.extname(file);
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[ext] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
let chrome, ws, serial = 0;
const pending = new Map(), errors = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || 'Browser evaluation failed');
  await delay(30); // Let user-triggered Web Locks transactions finish before the next action.
  return result.result.value;
}
async function check(name, expression) {
  assert.equal(await evaluate(expression), true, name);
  console.log('PASS ' + name);
}
async function reload() {
  await send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 100; i++) {
    await delay(30);
    if (await evaluate('document.readyState === "complete"')) return;
  }
  throw Error('Page failed to load');
}
async function screenshot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
}

(async () => {
  await new Promise(resolve => server.listen(4173, '127.0.0.1', resolve));
  chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  chrome.on('error', e => errors.push(e.message));
  let tabs;
  for (let i = 0; i < 100; i++) {
    try { tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (tabs.length) break; } catch {}
    await delay(100);
  }
  if (!tabs) throw Error('Chrome not available. Set CHROME_PATH if needed.');
  ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timeout);
      if (message.error) p.reject(Error(message.error.message)); else p.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || 'Runtime exception');
  });
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/mood-diary/' });
  for (let i = 0; i < 100; i++) { await delay(30); if (await evaluate('document.readyState === "complete"')) break; }

  await check('separate sample mode is available on first visit', '!!document.querySelector("#sampleToggle")');
  await evaluate('localStorage.clear()'); await reload();
  await evaluate('document.querySelector("[data-mood=anxious]").click(); document.querySelector("#note").value="<img src=x onerror=alert(1)> 汇报前紧张"; document.querySelector("#saveRecord").click()');
  await check('saves an entry to v2 and preserves literal user text', 'JSON.parse(localStorage.getItem("mood-diary-v2")).entries[0].note.startsWith("<img")');
  await evaluate('document.querySelector("[data-view=review]").click()');
  await check('renders diary content safely as text', '!document.querySelector("#historyList img") && document.querySelector("#historyList").textContent.includes("<img")');
  await screenshot('desktop-personal');
  await evaluate('window.personalBefore=localStorage.getItem("mood-diary-v2"); document.querySelector("#sampleToggle").click()');
  await check('sample mode clearly marked', '!document.querySelector("#sampleBanner").hidden');
  await evaluate('document.querySelector("#historyList [data-action=delete]").click()');
  await check('sample deletion never changes personal data', 'localStorage.getItem("mood-diary-v2") === window.personalBefore');
  await screenshot('desktop-review');
  await evaluate('document.querySelector("#sampleToggle").click()');
  await check('exiting sample restores personal record', 'document.querySelector("#historyList").textContent.includes("汇报前紧张")');
  await evaluate('document.querySelector("#historyList [data-action=edit]").click(); document.querySelector("#note").value="编辑后的记录"; document.querySelector("#saveRecord").click()');
  await check('editing preserves identity without creating duplicate entries', 'JSON.parse(localStorage.getItem("mood-diary-v2")).entries.length === 1 && JSON.parse(localStorage.getItem("mood-diary-v2")).entries[0].note === "编辑后的记录"');
  await evaluate('document.querySelector("[data-view=review]").click(); document.querySelector("#historyList [data-action=delete]").click()');
  await evaluate('document.querySelector("#undoDelete").click()');
  await check('undo restores deleted entry', 'JSON.parse(localStorage.getItem("mood-diary-v2")).entries.length === 1');
  await evaluate('document.querySelector("[data-view=record]").click(); document.querySelector("[data-mood=low]").click(); document.querySelector("#note").value="存储失败也不能丢失"; window.originalSet=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw Error("quota")}; document.querySelector("#saveRecord").click()');
  await check('failed save keeps the draft and existing records', 'document.querySelector("#note").value === "存储失败也不能丢失" && JSON.parse(localStorage.getItem("mood-diary-v2")).entries.length === 1 && !document.querySelector("#formError").hidden');
  await evaluate('Storage.prototype.setItem=window.originalSet; document.querySelector("#saveRecord").click()');

  await evaluate('document.querySelector("[data-start=breath]").click()');
  await check('activity opens with working pause control', 'document.querySelector("#activityDialog").open && !!document.querySelector("#pauseActivity")');
  await evaluate('document.querySelector("#pauseActivity").click(); window.remainingBefore=document.querySelector("#activityClock").textContent');
  await delay(1100);
  await check('pause freezes activity elapsed time', 'document.querySelector("#activityClock").textContent===window.remainingBefore');
  await evaluate('document.querySelector("#pauseActivity").click(); window.realNow=Date.now; window.timeOffset=59000; Date.now=()=>window.realNow()+window.timeOffset');
  await delay(350);
  await check('last exhalation is not skipped', 'document.querySelector("#phaseText").textContent.includes("呼气") && document.querySelector("#feedbackArea").hidden');
  await evaluate('window.timeOffset=61000'); await delay(350);
  await check('completion offers feedback after full duration', '!document.querySelector("#feedbackArea").hidden');
  await evaluate('document.querySelector("[data-feedback=better]").click(); Date.now=window.realNow');
  await check('activity feedback persists with completed session', 'JSON.parse(localStorage.getItem("mood-diary-v2")).sessions[0].feedback === "better"');
  await evaluate('document.querySelector("[data-start=breath]").click(); document.querySelector("#endActivity").click()');
  await check('early exit does not create a completed session', 'JSON.parse(localStorage.getItem("mood-diary-v2")).sessions.length === 1');
  await evaluate('document.querySelector("[data-view=care]").click(); document.querySelector("[data-start=rain]").click()');
  await check('rain sound starts an audio activity', 'document.querySelector("#activityDialog").open && document.querySelector("#activityTitle").textContent.includes("雨")');
  await evaluate('document.querySelector("#endActivity").click()');

  await evaluate('window.RealAudioContext=window.AudioContext; window.pendingRain=[]; window.testAudios=[]; window.AudioContext=class extends window.RealAudioContext { constructor(){super();window.testAudios.push(this)} resume(){return new Promise(resolve=>window.pendingRain.push(resolve))} }; document.querySelector("[data-start=rain]").click(); document.querySelector("#sampleToggle").click(); window.pendingRain[0]()');
  await delay(100);
  await check('switching mode cancels pending rain startup and closes its audio', '!document.querySelector("#activityDialog").open && window.testAudios.every(a=>a.state==="closed")');
  await evaluate('document.querySelector("#sampleToggle").click(); window.pendingRain=[]; window.testAudios=[]; document.querySelector("[data-start=rain]").click(); document.querySelector("[data-start=rain]").click(); window.pendingRain[1]()');
  await delay(50);
  await evaluate('window.pendingRain[0]()'); await delay(50);
  await evaluate('document.querySelector("#endActivity").click()'); await delay(50);
  await check('overlapping rain startups leave no orphan audio after ending', 'window.testAudios.every(a=>a.state==="closed")');
  await evaluate('window.AudioContext=window.RealAudioContext; document.querySelector("[data-start=breath]").click(); window.realNow=Date.now; Date.now=()=>window.realNow()+3000');
  await delay(250);
  await evaluate('document.querySelector("#pauseActivity").click(); document.querySelector("#pauseActivity").click()');
  await check('resumed breathing animation uses remaining phase duration', 'parseFloat(document.querySelector("#practiceOrb").style.transitionDuration)<=1.1');
  await evaluate('document.querySelector("#endActivity").click(); Date.now=window.realNow');

  await evaluate('localStorage.setItem("mood-diary-v2", "null")'); await reload();
  await check('corrupt storage is surfaced without overwriting the raw data', '!document.querySelector("#storageAlert").hidden && localStorage.getItem("mood-diary-v2")==="null"');
  await evaluate('localStorage.clear(); localStorage.setItem("mood-diary-v1",JSON.stringify([{id:123,mood:"calm",intensity:3,triggers:["工作"],note:"旧版日记"+"长".repeat(2500),ts:Date.now()}]))'); await reload();
  await evaluate('document.querySelector("[data-view=review]").click()');
  await check('legacy diary remains visible before migration', 'document.querySelector("#historyList").textContent.includes("旧版日记") && !localStorage.getItem("mood-diary-v2")');
  await evaluate('document.querySelector("#historyList [data-action=edit]").click()');
  await check('legacy long note can be edited without truncation', 'document.querySelector("#note").value.length===2504 && document.querySelector("#note").maxLength>=2504');
  await evaluate('document.querySelector("#saveRecord").click()');
  await check('legacy long note saves in full', 'JSON.parse(localStorage.getItem("mood-diary-v2")).entries[0].note.length===2504');

  await evaluate('document.querySelector("[data-view=record]").click(); document.querySelector("[data-mood=happy]").click(); document.querySelector("#note").value="当前页面的草稿"; window.other=window.open(location.href.split("#")[0]+"#record","mood-diary-peer"); void 0');
  await delay(500);
  await evaluate('window.other.document.querySelector("[data-mood=calm]").click(); window.other.document.querySelector("#note").value="另一个页面的记录"; window.other.document.querySelector("#saveRecord").click()');
  await delay(200);
  await check('another tab update keeps the local draft intact', 'document.querySelector("#note").value==="当前页面的草稿"');
  await evaluate('document.querySelector("#saveRecord").click()');
  await check('two tabs preserve each others saved entries', 'JSON.parse(localStorage.getItem("mood-diary-v2")).entries.length===3 && JSON.parse(localStorage.getItem("mood-diary-v2")).entries.some(e=>e.note==="另一个页面的记录")');
  await evaluate('window.other.localStorage.removeItem("mood-diary-v1"); window.other.localStorage.removeItem("mood-diary-v2")');
  await delay(150);
  await evaluate('document.querySelector("[data-view=record]").click(); document.querySelector("[data-mood=calm]").click(); document.querySelector("#note").value="清空之后的新记录"; document.querySelector("#saveRecord").click()');
  await check('another tab clearing data never resurrects old entries', 'JSON.parse(localStorage.getItem("mood-diary-v2")).entries.length===1 && JSON.parse(localStorage.getItem("mood-diary-v2")).entries[0].note==="清空之后的新记录"');
  await evaluate('window.other.close(); document.querySelector("[data-view=review]").click()');

  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: out });
  await evaluate('document.querySelector("#dataButton").click(); document.querySelector("#exportData").click()');
  await delay(200);
  const backups = fs.readdirSync(out).filter(name => name.startsWith('心晴日记-备份-') && name.endsWith('.json'));
  assert.ok(backups.length, 'exports downloadable backup');
  const backup = JSON.parse(fs.readFileSync(path.join(out, backups.at(-1)), 'utf8'));
  assert.equal(backup.entries[0].note, '清空之后的新记录');
  console.log('PASS exported backup contains the personal record');
  await evaluate('document.querySelector("#closeData").click()');
  await evaluate('document.querySelector("#sampleToggle").click()');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('mobile-review');
  await check('review fits mobile width', 'document.documentElement.scrollWidth <= innerWidth');
  await evaluate('document.querySelector("[data-view=record]").click()'); await screenshot('mobile-record');
  await check('record fits mobile width', 'document.documentElement.scrollWidth <= innerWidth');
  await evaluate('document.querySelector("[data-view=care]").click()'); await screenshot('mobile-care');
  await check('care fits mobile width', 'document.documentElement.scrollWidth <= innerWidth');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  for (const view of ['record', 'care', 'review']) {
    await evaluate(`document.querySelector('[data-view="${view}"]').click()`);
    await check('320px ' + view + ' does not overflow', 'document.documentElement.scrollWidth <= innerWidth');
  }
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
  console.log('PASS no browser runtime exceptions');
  console.log('Screenshots: ' + out);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  ws?.close(); chrome?.kill(); server.close();
  for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(Error('Browser closed')); }
});
