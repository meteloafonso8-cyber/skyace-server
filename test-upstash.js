'use strict';
// Testa a persistência no Upstash com um Upstash "falso" local: node test-upstash.js
const http = require('http'), { spawn } = require('child_process'), os = require('os'), fs = require('fs'), path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : ' FAIL ') + m); if (!c) fails++; };

const hashes = new Map(); let down = false, cmds = [];
const mock = http.createServer((req, res) => {
  if (down) { res.writeHead(503); return res.end('{}'); }
  if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const [cmd, key, f, v] = JSON.parse(b); cmds.push(cmd); let result = null;
    if (!hashes.has(key)) hashes.set(key, new Map());
    const h = hashes.get(key);
    if (cmd === 'HSET') { h.set(f, v); result = 1; }
    else if (cmd === 'HDEL') { result = h.delete(f) ? 1 : 0; }
    else if (cmd === 'HGETALL') result = [...h.entries()].flat();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result }));
  });
});
const start = port => new Promise(r => { const s = spawn('node', [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: port, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sa-')), ADMIN_KEY: 'k', UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:18111', UPSTASH_REDIS_REST_TOKEN: 'tok', REMOTE_RETRY_MS: 300 }, stdio: 'ignore' }); setTimeout(() => r(s), 700); });
const post = (port, p, b, h = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) }).then(r => r.json());
const top = port => fetch(`http://127.0.0.1:${port}/api/top`).then(r => r.json());

mock.listen(18111, async () => {
  const pa = 'a'.repeat(32), pb = 'b'.repeat(32);
  let s = await start(18110);
  const h0 = await fetch('http://127.0.0.1:18110/health').then(r => r.json());
  ok(h0.storage === 'upstash', '/health indica storage=upstash');
  await post(18110, '/api/score', { pid: pa, name: 'Ana', score: 5000, time: 60, level: 3 });
  await post(18110, '/api/score', { pid: pb, name: 'Rui', score: 7000, time: 60, level: 4 });
  await sleep(400);
  ok(hashes.get('skyace:scores')?.size === 2, 'pontuações gravadas no Upstash');
  s.kill(); await sleep(300);
  s = await start(18110); await sleep(300);
  let t = await top(18110);
  ok(t.top.length === 2 && t.top[0].n === 'Rui', 'depois de reiniciar o servidor o ranking continua lá');
  await post(18110, '/api/admin/delete', { name: 'Rui' }, { 'X-Admin-Key': 'k' }); await sleep(300);
  ok(hashes.get('skyace:scores').size === 1, 'apagar por moderação também apaga no Upstash');
  s.kill(); await sleep(300);
  // Upstash em baixo no arranque → o servidor arranca na mesma e recupera
  down = true; s = await start(18110);
  const r = await post(18110, '/api/score', { pid: 'c'.repeat(32), name: 'Zé', score: 100, time: 30, level: 1 });
  ok(r.ok === true, 'com o Upstash em baixo o servidor continua a responder');
  down = false; await sleep(1500);
  t = await top(18110);
  ok(t.top.some(e => e.n === 'Ana'), 'quando o Upstash volta, o ranking antigo é carregado');
  s.kill(); mock.close();
  console.log(fails ? `\n${fails} FALHAS` : '\nTESTES UPSTASH PASSARAM'); process.exit(fails ? 1 : 0);
});
