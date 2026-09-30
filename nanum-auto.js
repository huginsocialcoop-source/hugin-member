#!/usr/bin/env node
'use strict';
/* ═════════════════════════════════════════════════════════════════════
   해피나눔 자동 다운로더 — 로그인부터 대시보드 반영까지 전 자동
   ─────────────────────────────────────────────────────────────────────
   [최초 1회 설정] data/nanum-credentials.json 에 아이디·비밀번호 저장
     { "id": "아이디", "password": "비밀번호" }
     ※ 절대 채팅·이메일로 전송하지 말 것 — 이 파일은 그대로 PC에만 존재

   [매주 실행 (예약 등록 가능)]
     node nanum-auto.js            → 로그인 → 다운로드 → 집계 → 대시보드 반영
     node nanum-auto.js --probe    → 다운로드 없이 로그인·화면 구조만 진단(문제 시 debug/ 저장)
   ═════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');

const ask = q => new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); res(a.trim()); });
});

const BASE = 'https://www.ihappynanum.com';
const LOGIN_PAGE = BASE + '/Nanum/nanum/user/mem/Mem0201.nanum';
const DL_PAGE = BASE + '/Nanum/nanum/user/extra/dataDownload';
const ROOT = __dirname;
const DIR = path.join(ROOT, 'nanum-weekly');
const DBG = path.join(DIR, 'debug');
const CONF = path.join(ROOT, 'data', 'nanum-credentials.json');
const PROBE = process.argv.includes('--probe');

function log(m) { console.log('· ' + m); }
function die(m) { console.error('✕ ' + m); process.exitCode = 1; process.exit(); }

/* ── 쿠키 유지 HTTP 클라이언트 (의존성 없음) ── */
const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
function storeCookies(res) {
  for (const c of (res.headers['set-cookie'] || [])) {
    const pair = c.split(';')[0], i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
function req(u, { method = 'GET', form = null } = {}) {
  return new Promise((resolve, reject) => {
    const U = new URL(u), mod = U.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0', 'Referer': BASE + '/', 'Accept': '*/*' };
    if (cookieHeader()) headers['Cookie'] = cookieHeader();
    let body = null;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = mod.request(U, { method, headers }, res => {
      storeCookies(res);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const st = res.statusCode || 0, loc = res.headers.location;
        if ([301, 302, 303].includes(st) && loc) return resolve(req(new URL(loc, U).href));
        resolve({ status: st, buf: Buffer.concat(chunks), disp: res.headers['content-disposition'] || '', type: res.headers['content-type'] || '' });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function decode(buf) {
  try { return new TextDecoder('euc-kr', { fatal: true }).decode(buf); } catch (e) { /* not euc-kr */ }
  return buf.toString('utf8');
}
const abs = (u, ref) => { try { return new URL(u, ref).href; } catch (e) { return null; } };

/* ── 로그인 폼 자동 인식 후 로그인 ── */
async function login(cred) {
  const p1 = await req(LOGIN_PAGE);
  const html = decode(p1.buf);
  fs.mkdirSync(DBG, { recursive: true });
  fs.writeFileSync(path.join(DBG, 'login-page.html'), html);
  const formM = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
  let target = null;
  for (const f of formM) if (/<input[^>]*type=["']?password/i.test(f)) { target = f; break; }
  if (!target) die('로그인 폼(비밀번호 입력란)을 찾지 못했습니다. debug/login-page.html 을 공유해 주세요.');
  const action = (target.match(/action\s*=\s*["']?([^"'\s>]*)/i) || [])[1] || LOGIN_PAGE;
  const method = ((target.match(/method\s*=\s*["']?([^"'\s>]*)/i) || [])[1] || 'post').toUpperCase();
  const fields = {};
  let idField = null, pwField = null;
  for (const im of target.matchAll(/<input\b[^>]*>/gi)) {
    const tag = im[0];
    const name = (tag.match(/name\s*=\s*["']?([^"'\s>]*)/i) || [])[1];
    if (!name) continue;
    const type = ((tag.match(/type\s*=\s*["']?([^"'\s>]*)/i) || [])[1] || 'text').toLowerCase();
    const value = (tag.match(/value\s*=\s*["']?([^"']*)/i) || [])[1] || '';
    if (type === 'password') pwField = name; else fields[name] = value;
    if (/user_?id|login_?id|^id$|mber|member|username|email|account/i.test(name) && type !== 'password' && type !== 'hidden') idField = idField || name;
  }
  if (!pwField) die('비밀번호 입력 필드명을 찾지 못했습니다. debug/login-page.html 을 공유해 주세요.');
  if (!idField) { idField = Object.keys(fields).find(n => n !== pwField) || 'userId'; }
  fields[pwField] = cred.password;
  fields[idField] = cred.id;
  const postURL = abs(action, LOGIN_PAGE) || LOGIN_PAGE;
  log(`로그인 시도 → ${postURL} (${method}, id필드: ${idField})`);
  const p2 = await req(postURL, { method, form: fields });
  const html2 = decode(p2.buf);
  fs.writeFileSync(path.join(DBG, 'after-login.html'), html2);
  if (/로그인\s*실패|비밀번호를\s*다시|아이디\/비밀번호를\s*확인/.test(html2)) die('로그인 실패 — 아이디/비밀번호를 확인하세요. (data/nanum-credentials.json)');
  log('로그인 성공으로 보입니다 (세션 쿠키 ' + jar.size + '개)');
  return html2;
}

/* ── 다운로드 화면에서 파일 요청 경로 자동 탐색 ── */
async function findDownload(afterLoginHtml) {
  let url = process.env.NANUM_DL_URL || null, form = null, ref = DL_PAGE;
  const p = await req(DL_PAGE);
  let html = decode(p.buf);
  fs.writeFileSync(path.join(DBG, 'download-page.html'), html);
  if (/로그인\s*실패|비밀번호를\s*다시/.test(html)) die('다운로드 화면 접근 시 로그인 상태가 아닙니다. 로그인 과정을 --probe 로 확인하세요.');
  log(`다운로드 화면 도착 (${p.status}, ${(html.length / 1024).toFixed(0)}KB)`);
  if (url) { log('설정 파일의 downloadUrl 사용'); return { url: abs(url, DL_PAGE), form: null, ref }; }
  const direct = html.match(/href\s*=\s*["']([^"']*\.(?:xlsx|xls|csv)[^"']*)["']/i);
  const link = html.match(/href\s*=\s*["']([^"']*(?:[Dd]own(?:load)?|export)[^"']*\.nanum[^"']*)["']/i);
  if (direct || link) { url = abs((direct || link)[1], DL_PAGE); log('파일 링크 발견: ' + url); return { url, form: null, ref }; }
  for (const f of (html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [])) {
    if (!/[Dd]own|export/i.test(f)) continue;
    const act = (f.match(/action\s*=\s*["']?([^"'\s>]*)/i) || [])[1] || '';
    const fields = {};
    for (const im of f.matchAll(/<input\b[^>]*>/gi)) {
      const name = (im[0].match(/name\s*=\s*["']?([^"'\s>]*)/i) || [])[1];
      if (name) fields[name] = (im[0].match(/value\s*=\s*["']?([^"']*)/i) || [])[1] || '';
    }
    url = abs(act, DL_PAGE); form = fields;
    log('다운로드 폼 발견: ' + url + ' (필드 ' + Object.keys(fields).length + '개)');
    return { url, form, ref };
  }
  const js = [...html.matchAll(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/g)].map(m => m[1]).find(u => /down|export/i.test(u));
  if (js) { url = abs(js, DL_PAGE); log('JS 이동 경로 발견: ' + url); return { url, form: null, ref }; }
  die('다운로드 링크를 자동으로 찾지 못했습니다. --probe 후 debug/download-page.html 을 공유해 주시면 이 경로에 맞춰 드리겠습니다.');
}

/* ── 파일 받아 nanum-weekly/ 저장 → 집계 업로드 ── */
async function download(dl) {
  const r = dl.form ? await req(dl.url, { method: 'POST', form: dl.form }) : await req(dl.url);
  fs.writeFileSync(path.join(DBG, 'download-response.bin'), r.buf);
  const isFile = /octet-stream|excel|spreadsheet|csv/i.test(r.type) || /attachment/i.test(r.disp) || /\.(xlsx|xls|csv)/i.test(r.disp);
  if (!isFile) die('응답이 파일이 아닙니다(아마 화면). debug/download-response.bin 과 download-page.html 을 공유해 주세요.');
  let name = (r.disp.match(/filename\*?=(?:UTF-8''|")?([^"';]+)/i) || [])[1];
  try { if (name && /%/.test(name)) name = decodeURIComponent(name); } catch (e) {}
  const d = new Date(), ds = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const safe = (name || `해피나눔_조합원_${ds}.xlsx`).replace(/[\\/:*?"<>|]/g, '_');
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, safe);
  fs.writeFileSync(out, r.buf);
  log(`저장 완료: ${out} (${(r.buf.length / 1024).toFixed(0)}KB)`);
  if (!PROBE) {
    log('수집기로 업로드·집계 중…');
    const w = spawn(process.execPath, [path.join(ROOT, 'nanum-weekly.js')], { stdio: 'inherit' });
    w.on('exit', c => process.exitCode = c || 0);
  } else log('probe 모드 — 업로드는 건너뜁니다');
}

(async () => {
  let cred = null;
  if (fs.existsSync(CONF)) {
    try { cred = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch (e) { die('data/nanum-credentials.json 해석 실패: ' + e.message); }
  }
  if (!cred || !cred.id || !cred.password || String(cred.id).includes('여기에')) {
    if (!process.stdin.isTTY) {
      fs.mkdirSync(path.dirname(CONF), { recursive: true });
      fs.writeFileSync(CONF, JSON.stringify({ id: '여기에_아이디', password: '여기에_비밀번호' }, null, 2));
      die(`자격 증명이 필요합니다: ${CONF}\n  이 파일을 열어 아이디·비밀번호를 저장한 뒤 다시 실행하세요. (채팅에 올리지 마세요)\n  또는 명령창에서 직접 실행하면 입력창이 뜹니다.`);
    }
    console.log('최초 실행 — 해피나눔 아이디·비밀번호를 입력하면 이 PC의 data/nanum-credentials.json 에만 저장됩니다.');
    const id = await ask('  아이디: ');
    const pw = await ask('  비밀번호: ');
    if (!id || !pw) die('아이디와 비밀번호가 모두 필요합니다.');
    cred = { id, password: pw };
    fs.mkdirSync(path.dirname(CONF), { recursive: true });
    fs.writeFileSync(CONF, JSON.stringify(cred, null, 2));
    log('자격 증명 저장 완료: ' + CONF);
  }
  const dl = await (async () => {
    await login(cred);
    return findDownload();
  })();
  await download(dl);
})().catch(e => die(String(e && e.message || e)));
