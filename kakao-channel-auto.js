#!/usr/bin/env node
'use strict';
/* ═════════════════════════════════════════════════════════════════════
   카카오 파트너센터 · 채널 통계 자동 수집 (세션 유지 반자동)
   ─────────────────────────────────────────────────────────────────────
   원리: 조합 PC의 Chrome 프로필(.kakao-profile/)에 파트너센터 로그인
   세션을 저장해 두고, 매주 예약 실행 시 로그인 상태로 통계 페이지에서
   친구 통계 리포트를 내려받아 nanum-weekly.js로 집계·반영합니다.

   [최초 1회 — 눈으로 보는 로그인]
     node kakao-channel-auto.js --login
     → Chrome 창이 열리면 파트너센터에 로그인(기기 인증 등 직접 처리)
     → 로그인 후 콘솔로 복귀하면 세션이 .kakao-profile/ 에 저장됨

   [매주 실행 — 무인]
     node kakao-channel-auto.js
     → 세션 유효 시: 통계 리포트 다운로드 → 자동 집계 → 대시보드 반영
     → 세션 만료 시: 창을 열어 재로그인 요청 후 계속

   [사전 설치] (1회)
     npm init -y && npm install puppeteer-core
     ※ Chrome이 설치돼 있어야 합니다 (자동 탐지, 없으면 CHROME_PATH 지정)
   ═════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const PROFILE = path.join(ROOT, '.kakao-profile');
const OUTDIR = path.join(ROOT, 'nanum-weekly');
const CONF = path.join(ROOT, 'data', 'kakao-channel.json');

/* 파트너센터 주소 — 채널 ID는 관리 페이지 설정값과 동일(_xoLxifxj) */
const SPACE_URL = (process.env.KAKAO_SPACE_URL ||
  'https://business.kakao.com/space/564193/channel/_xoLxifxj/statistics/reports');
const FRIEND_URL = SPACE_URL.replace('/reports', '/friend');
const LOGIN_ONLY = process.argv.includes('--login');
const DEBUG = process.argv.includes('--debug');

function log(m) { console.log('· ' + m); }
function die(m) { console.error('✕ ' + m); process.exit(1); }

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'
  ];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  die('Chrome을 찾지 못했습니다 — CHROME_PATH 환경변수에 chrome.exe 경로를 지정하세요.');
}

async function main() {
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch (e) { die('puppeteer-core 미설치 — kakao-sync 폴더에서: npm init -y && npm install puppeteer-core'); }
  const conf = fs.existsSync(CONF) ? JSON.parse(fs.readFileSync(CONF, 'utf8')) : {};
  const executablePath = conf.chromePath || findChrome();
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(OUTDIR, { recursive: true });

  /* 1차: 저장된 프로필로 무인 시도. 로그인 화면으로 가면 눈으로 로그인 */
  let browser = await puppeteer.launch({
    executablePath,
    userDataDir: PROFILE,
    headless: LOGIN_ONLY ? false : (conf.headless !== false),
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--lang=ko']
  });
  const page = (await browser.pages())[0] || await browser.newPage();

  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUTDIR, eventsEnabled: true });

  const isLoginPage = () => page.url().includes('accounts.kakao.com') || page.url().includes('logon');
  async function ensureLogin() {
    await page.goto(FRIEND_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    if (!isLoginPage()) return true;
    console.log('\n  ── 로그인 필요: 열린 Chrome 창에서 파트너센터에 로그인하세요 (기기 인증 포함) ──');
    if (conf.headless !== false && !LOGIN_ONLY) {
      await browser.close();
      browser = await puppeteer.launch({ executablePath, userDataDir: PROFILE, headless: false, args: ['--window-size=1280,900', '--lang=ko'] });
      const p2 = (await browser.pages())[0] || await browser.newPage();
      await p2.goto(FRIEND_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    }
    // 로그인 완료(통계 화면 도달)를 최대 10분까지 기다림
    for (let i = 0; i < 200; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (!isLoginPage() && /statistics|channel/i.test(page.url())) break;
    }
    if (isLoginPage()) die('로그인이 완료되지 않았습니다 — 다시 실행해 주세요.');
    log('로그인 확인 — 세션이 .kakao-profile/ 에 저장됩니다');
    return true;
  }

  await ensureLogin();
  if (LOGIN_ONLY) {
    log('세션 저장 완료. 이제 매주 자동 실행할 수 있습니다: node kakao-channel-auto.js');
    await browser.close();
    return;
  }

  /* 친구 통계 화면에서 내려받기 실행 */
  await page.goto(FRIEND_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  if (DEBUG) await page.screenshot({ path: path.join(ROOT, 'debug-friend-page.png'), fullPage: true }).catch(() => {});
  const before = new Set(fs.readdirSync(OUTDIR));
  let clicked = false;
  for (const sel of ['[class*="download"]', '[class*="Download"]', 'button', 'a']) {
    const handles = await page.$$(sel).catch(() => []);
    for (const h of handles) {
      const txt = (await h.evaluate(el => (el.innerText || el.getAttribute('aria-label') || '')).catch(() => '')) || '';
      if (/내려받기|다운로드|download|excel|엑셀/i.test(txt)) {
        await h.click().catch(() => {});
        clicked = true;
        log(`다운로드 버튼 클릭: "${txt.trim().slice(0, 20)}"`);
        break;
      }
    }
    if (clicked) break;
  }
  if (!clicked) die('내려받기 버튼을 찾지 못했습니다 — --debug 로 실행 후 debug-friend-page.png 를 공유해 주세요.');

  /* 파일 도착 대기 (최대 60초) */
  let outFile = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const now = fs.readdirSync(OUTDIR).filter(f => !before.has(f) && /\.(xlsx|xls|csv)$/i.test(f) && !f.endsWith('.crdownload'));
    if (now.length) { outFile = now[0]; break; }
  }
  if (!outFile) die('파일이 도착하지 않았습니다 — --debug 실행 후 화면 캡처를 공유해 주세요.');
  log(`리포트 저장: ${outFile}`);

  /* 집계·반영 */
  log('수집기로 집계·반영 중…');
  const w = spawn(process.execPath, [path.join(ROOT, 'nanum-weekly.js')], { stdio: 'inherit' });
  w.on('exit', async c => { await browser.close().catch(() => {}); process.exitCode = c || 0; });
}

main().catch(e => die(String(e && e.message || e)));
