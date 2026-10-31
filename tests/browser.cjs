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
  await evaluate('document.querySelector("[data-view=review]").click(); document.querySelector("#historyList [data-action=delete]").click(); document.querySelector("#undoDelete").click()');
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

  await evaluate('localStorage.setItem("mood-diary-v2", "null")'); await reload();
  await check('corrupt storage is surfaced without overwriting the raw data', '!document.querySelector("#storageAlert").hidden && localStorage.getItem("mood-diary-v2")==="null"');
  await evaluate('localStorage.clear(); localStorage.setItem("mood-diary-v1",JSON.stringify([{id:123,mood:"calm",intensity:3,triggers:["工作"],note:"旧版日记",ts:Date.now()}]))'); await reload();
  await evaluate('document.querySelector("[data-view=review]").click()');
  await check('legacy diary remains visible before migration', 'document.querySelector("#historyList").textContent.includes("旧版日记") && !localStorage.getItem("mood-diary-v2")');
  await evaluate('document.querySelector("#sampleToggle").click()');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('mobile-review');
  await check('review fits mobile width', 'document.documentElement.scrollWidth <= innerWidth');
  await evaluate('document.querySelector("[data-view=record]").click()'); await screenshot('mobile-record');
  await check('record fits mobile width', 'document.documentElement.scrollWidth <= innerWidth');
  await evaluate('document.querySelector("[data-view=care]").click()'); await screenshot('mobile-care');
  await check('care fits mobile width', 'document.documentElement.scrollWidth <= innerWidth');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  await check('small phones do not overflow', 'document.documentElement.scrollWidth <= innerWidth');
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
  console.log('PASS no browser runtime exceptions');
  console.log('Screenshots: ' + out);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  ws?.close(); chrome?.kill(); server.close();
  for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(Error('Browser closed')); }
});
