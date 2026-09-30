#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════
   해피나눔 조합원 파일 · 주간 자동 집계
   ───────────────────────────────────────────────────────────────
   주간 루틴 (3분):
   1. 해피나눔 > 조합원 정보 다운로드에서 파일 받기 (.xlsx / .csv)
   2. 이 스크립트와 같은 폴더의  nanum-weekly/  폴더에 파일 저장
   3. 스크립트가 최신 파일을 찾아 수집기로 업로드 → 대시보드 자동 반영

   실행:  node nanum-weekly.js [폴더] [수집기주소]
          node nanum-weekly.js                  ← 기본값 사용
          node nanum-weekly.js --check          ← 업로드 없이 상태만 확인
   예약:  매주 자동 실행 등록은 README '주간 자동화' 참고
   ═══════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DIR = path.join(__dirname, 'nanum-weekly');
const URLBASE = process.argv.filter(a => /^https?:\/\//.test(a))[0] || process.env.NANUM_SERVER || 'http://localhost:8787';
const CHECK_ONLY = process.argv.includes('--check');
const LOG = path.join(__dirname, 'nanum-weekly.log');

function log(msg) { const line = `[${new Date().toLocaleString('ko-KR', { hour12: false })}] ${msg}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); }
function pickFile() {
  if (!fs.existsSync(DIR)) { fs.mkdirSync(DIR, { recursive: true }); return null; }
  const files = fs.readdirSync(DIR)
    .filter(f => /\.(xlsx|csv)$/i.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? files[0].f : null;
}
function post(obj) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const req = (URLBASE.startsWith('https') ? https : http).request(URLBASE + '/api/members/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('응답 해석 실패: ' + b.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function main() {
  if (CHECK_ONLY) {
    const base = URLBASE.replace(/\/+$/, '');
    https_get(base + '/api/members/summary').then(j => {
      const o = JSON.parse(j);
      log(o.ok ? `현재 집계: 총 ${o.total.toLocaleString()}명 · ${o.importedAt} (${o.source})` : '아직 업로드된 조합원 파일이 없습니다.');
    }).catch(e => log('수집기에 연결할 수 없습니다: ' + e.message));
    return;
  }
  const f = pickFile();
  if (!f) { log(`nanum-weekly/ 폴더에 엑셀·CSV가 없습니다. 해피나눔에서 다운로드한 파일을 이 폴더에 넣고 다시 실행하세요. (${DIR})`); process.exitCode = 1; return; }
  const b64 = fs.readFileSync(path.join(DIR, f)).toString('base64');
  log(`업로드 중: ${f} (${(Buffer.byteLength(b64, 'base64') / 1024).toFixed(0)}KB) → ${URLBASE}`);
  try {
    const r = await post({ name: f, dataBase64: b64 });
    if (r.error) { log(`집계 실패: ${r.error}`); process.exitCode = 1; return; }
    log(`완료 · 총 ${r.total.toLocaleString()}명 · 월별 ${r.monthly.length}개월 · 연령 ${r.age.length}개층 · 지역 ${r.region.length}곳 · 스킵 ${r.skippedRows}행 — 대시보드에 반영되었습니다.`);
  } catch (e) { log(`수집기 연결 실패: ${e.message} — server.js가 실행 중인지 확인하세요 (${URLBASE})`); process.exitCode = 1; }
}
function https_get(url) {
  return new Promise((resolve, reject) => {
    (url.startsWith('https') ? https : http).get(url, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }).on('error', reject);
  });
}
main();
