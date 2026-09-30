#!/usr/bin/env node
'use strict';
/* 해피나눔 자격 증명 입력기 — setup-windows.bat에서 호출, data/nanum-credentials.json에만 저장 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const CONF = path.join(__dirname, 'data', 'nanum-credentials.json');
const ask = q => new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.question(q, a => { rl.close(); res(a.trim()); });
});
(async () => {
  const id = await ask('  해피나눔 아이디: ');
  const pw = await ask('  해피나눔 비밀번호: ');
  if (!id || !pw) { console.error('아이디와 비밀번호가 모두 필요합니다.'); process.exit(1); }
  fs.mkdirSync(path.dirname(CONF), { recursive: true });
  fs.writeFileSync(CONF, JSON.stringify({ id, password: pw }, null, 2));
  console.log('  저장 완료 → data/nanum-credentials.json (이 PC에만 존재)');
})().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
