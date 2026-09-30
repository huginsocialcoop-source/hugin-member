#!/usr/bin/env node
'use strict';
/* ═════════════════════════════════════════════════════════════════════
   허그인사회적협동조합 · 카카오 채널 데이터 수집기
   ─────────────────────────────────────────────────────────────────────
   카카오는 채널 전체 친구 수·증감 추이·게시물 도달 통계의 공개 API를
   제공하지 않습니다(카카오 데브톡 공식 답변, 2026-08). 대신 공식 API가
   실제로 제공하는 두 가지 통로로 추이 데이터를 자체 구축합니다.

   1) 카카오톡 채널 웹훅 (공식, 실시간)
      - 사용자가 채널 추가(added)/차단(blocked)할 때마다 이 서버로 이벤트가 옴
      - POST /webhook/kakao  → 일별 추가·차단 집계
   2) 파트너센터 통계 백필 (반자동)
      - 파트너센터 > 통계 > 친구 통계를 엑셀로 내려받아 CSV로 저장 후
        관리 페이지(/admin)에서 업로드 → 과거 일별 추이를 한 번에 채움
   3) 기준 친구 수 1회 입력
      - 웹훅은 증감만 주므로, 현재 친구 수를 /admin에서 1회 입력하면
        이후 친구 수가 자동으로 계산됩니다.

   실행:  node server.js   (기본 포트 8787, PORT 환경변수로 변경)
   대시보드:  http://localhost:8787/  ← 이 서버가 대시보드 HTML도 서빙
   관리:      http://localhost:8787/admin

   외부 의존성 없음 (Node.js 18+ 내장 모듈만 사용).
   ═════════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');
const F = {
  config: path.join(DATA_DIR, 'config.json'),
  history: path.join(DATA_DIR, 'history.json'),
  events: path.join(DATA_DIR, 'events.json'),
  manual: path.join(DATA_DIR, 'manual.json'),
  oauth: path.join(DATA_DIR, 'oauth.json'),
  members: path.join(DATA_DIR, 'members.json')
};

function load(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }
function save(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1)); }

let config = load(F.config, { kakaoAdminKey: '', adminToken: '', restApiKey: '', clientSecret: '', baseline: null, channelPublicId: '' });
let oauthLog = load(F.oauth, { last: null });
let membersState = load(F.members, null); // 조합원 파일 집계 결과 (해피나눔 다운로드 → 업로드)
let history = load(F.history, { imported: {}, lastImport: null });   // { 'YYYY-MM-DD': {join, block, friends?} }  ← CSV 백필 (해당 일자의 공식 값)
let events = load(F.events, { seen: [], log: [] }); // 웹훅 원본 로그
let manual = load(F.manual, {});                   // { posts: [[제목,날짜,도달,반응,클릭]...], chat: {week, month} }  ← 선택, 수동 관리

function kstDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* OAuth 오류 → 원인·해결 안내 매핑 */
function oauthHint(msg) {
  const m = String(msg || '');
  if (/redirect/i.test(m)) return { why: 'Redirect URI 불일치 또는 미등록', fix: '카카오 콘솔 [앱] > [플랫폼 키] > [카카오 로그인 리다이렉트 URI]에 관리 페이지에 표시된 /oauth/callback 주소가 "정확히" 등록돼 있는지 확인하세요 (끝 슬래시·http/https까지 일치).' };
  if (/활성|disable|enable/i.test(m)) return { why: '카카오 로그인이 비활성 상태', fix: '콘솔 왼쪽 메뉴의 [카카오 로그인] 그룹 > [사용 설정]에서 상태를 ON으로 바꾸세요.' };
  if (/secret/i.test(m)) return { why: '클라이언트 시크릿 필요 (앱에서 시크릿 활성화 ON)', fix: '관리 페이지 설정의 [클라이언트 시크릿] 입력란에 시크릿 코드를 저장하고 다시 시도하세요. (콘솔 [앱] > [플랫폼 키] > [REST API 키] > [클라이언트 시크릿]에서 확인. 시크릿을 안 쓰려면 OFF로 전환해도 됩니다.)' };
  if (/scope|동의|consent|-402|KOE040/i.test(m)) return { why: '동의항목(plusfriends) 미설정 또는 미동의', fix: '콘솔 [카카오 로그인] > [동의항목]에서 "카카오톡 채널 추가 상태 및 내역"을 추가한 뒤 다시 시도하세요.' };
  if (/invalid_grant|code/i.test(m)) return { why: '인가 코드 만료/재사용', fix: '승인 코드는 1회용입니다 — 관리 페이지에서 연결 테스트 버튼을 다시 누르세요.' };
  if (/client|KOE009|app key|api ?key/i.test(m)) return { why: 'REST API 키 문제', fix: '관리 페이지의 앱 REST API 키 값과 콘솔 [앱] > [플랫폼 키]의 REST API 키가 같은지 다시 확인하세요.' };
  if (/채널|channel/i.test(m)) return { why: '앱-채널 연결 안 됨', fix: '앱에 카카오톡 채널이 연결돼 있어야 목록이 반환됩니다. [앱] > [카카오톡 채널]에서 연결 상태를 확인하거나, 대표 채널 설정(심사 후)이 필요합니다.' };
  return { why: '기타 오류', fix: '아래 원문 오류를 그대로 알려주시면 정확히 짚어드립니다.' };
}
function logOAuth(ok, detail) {
  oauthLog.last = { at: new Date().toISOString(), ok, detail: String(detail || '').slice(0, 300) };
  save(F.oauth, oauthLog);
}

/* ═══ 조합원 파일(엑셀/CSV) 읽기·집계 — 해피나눔 다운로드용 ═══ */
function readXlsxRows(buf) {
  const zlib = require('zlib');
  let eo = buf.length - 22;
  while (eo >= 0 && buf.readUInt32LE(eo) !== 0x06054b50) eo--;
  if (eo < 0) throw new Error('엑셀(zip) 형식을 읽을 수 없습니다');
  const count = buf.readUInt16LE(eo + 10);
  let p = buf.readUInt32LE(eo + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const n2 = buf.readUInt16LE(lho + 26), e2 = buf.readUInt16LE(lho + 28);
    const dstart = lho + 30 + n2 + e2;
    files[name] = () => { const raw = buf.subarray(dstart, dstart + csize); return method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw); };
    p += 46 + nlen + elen + clen;
  }
  const dec = s => s.toString('utf8')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
  const sst = [];
  if (files['xl/sharedStrings.xml']) {
    for (const m of files['xl/sharedStrings.xml']().toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g))
      sst.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => dec(Buffer.from(x[1]))).join(''));
  }
  const sheet = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheet) throw new Error('엑셀 시트를 찾지 못했습니다');
  const xml = files[sheet]().toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = [...cm[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = (cm[2].match(/t="([^"]*)"/) || [])[1];
      let v = cm[3] != null ? ((cm[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1]) : undefined;
      if (v == null && cm[3] && /<is>/.test(cm[3])) v = (cm[3].match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      if (v == null) { cells[col] = ''; continue; }
      cells[col] = t === 's' ? (sst[Number(v)] ?? '') : dec(Buffer.from(v));
    }
    rows.push(cells);
  }
  return rows;
}
function parseAnyDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{5}$/.test(String(v).trim())) {
    const n = Number(v);
    if (n > 20000 && n < 60000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
    return null;
  }
  return parseDateCell(v);
}
function binAge(a) { return a < 10 ? '10대 미만' : a < 20 ? '10대' : a < 30 ? '20대' : a < 40 ? '30대' : a < 50 ? '40대' : a < 60 ? '50대' : a < 70 ? '60대' : a < 80 ? '70대' : '80대 이상'; }
const AGE_ORDER = ['10대 미만', '10대', '20대', '30대', '40대', '50대', '60대', '70대', '80대 이상'];
function normGender(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/^여|f$|female|^2$/.test(s)) return '여성';
  if (/^남|m$|male|^1$/.test(s)) return '남성';
  return '무응답';
}
function normRegion(v) {
  const toks = String(v || '').trim().split(/\s+/);
  const sig = toks.find(t => /(시|군|구)$/.test(t) && !/시$/.test(t.slice(0, -1)) || /(시|군|구)$/.test(t));
  const gu = toks.find(t => /(시|군|구)$/.test(t));
  if (!gu) return String(v || '').trim().slice(0, 8) || '기타';
  const rest = toks.filter(t => t !== gu && /(동|읍|면|로|길)$/.test(t))[0];
  return rest ? gu + ' ' + rest.slice(0, 3) : gu;
}
/* .xls(구형)/.xlsx/CSV → CSV 텍스트 (서버 쪽에서 자동 변환) */
function csvFromSheet(buf, tmpName) {
  if (buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b) { // zip = .xlsx
    return readXlsxRows(buf).map(r => r.map(c => { const v = String(c ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n');
  }
  if (buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf) { // OLE2 = 구형 .xls
    try {
      const { spawnSync } = require('child_process');
      const tmp = path.join(require('os').tmpdir(), 'xls-conv-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      const inF = path.join(tmp, tmpName || 'input.xls');
      fs.writeFileSync(inF, buf);
      let r = spawnSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', tmp, inF], { timeout: 30000 });
      if (r.error || !fs.existsSync(path.join(tmp, path.basename(inF, path.extname(inF)) + '.csv'))) r = spawnSync('libreoffice', ['--headless', '--convert-to', 'csv', '--outdir', tmp, inF], { timeout: 30000 });
      const out = path.join(tmp, (path.basename(inF, path.extname(inF))) + '.csv');
      if (fs.existsSync(out) && fs.statSync(out).size > 0) { const t = fs.readFileSync(out, 'utf8'); fs.rmSync(tmp, { recursive: true, force: true }); return t; }
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error('xls 변환 실패' + (r.error ? ' (LibreOffice 없음)' : ''));
    } catch (e) { throw new Error("구형 .xls 파일입니다 — 엑셀에서 [다른 이름으로 저장] → CSV로 저장해서 올려주세요"); }
  }
  return buf.toString('utf8');
}
function aggregateMembers(rows, srcName) {
  if (!rows || rows.length < 2) throw new Error('파일에 데이터 행이 없습니다');
  const head = rows[0].map(h => String(h ?? '').trim());
  const findCol = res => head.findIndex(h => h && res.some(re => re.test(h)));
  const iJoin = findCol([/가입일|등록일|입회일|가입\s*일자|조합원\s*등록/]);
  const iLeave = findCol([/탈퇴일|해지일|만기일|탈퇴\s*일자/]);
  const iBirth = findCol([/생년월일|생년|생일/]);
  const iAge = findCol([/나이|연령/]);
  const iGender = findCol([/성별/]);
  const iRegion = findCol([/주소|거주지|지역|사는곳/]);
  if (iJoin < 0) throw new Error('가입일 열을 찾지 못했습니다. 인식한 헤더: ' + head.filter(Boolean).join(' | '));
  const nowK = kstDate(new Date().toISOString());
  const months = [];
  { const d = new Date(); for (let k = 11; k >= 0; k--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)); months.push(String(x.getUTCFullYear()).slice(2) + '.' + String(x.getUTCMonth() + 1).padStart(2, '0')); } }
  const joinM = {}, leaveM = {}, ageBins = {}, genderC = {}, regionC = {};
  let total = 0, warn = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const jd = parseAnyDate(row[iJoin]);
    if (!jd) { if (row.some(c => String(c ?? '').trim())) warn++; continue; }
    const ym = jd.slice(2, 4) + '.' + jd.slice(5, 7);
    const ld = iLeave >= 0 ? parseAnyDate(row[iLeave]) : null;
    if (!ld) total++;
    joinM[ym] = (joinM[ym] || 0) + 1;
    if (ld) { const lym = ld.slice(2, 4) + '.' + ld.slice(5, 7); leaveM[lym] = (leaveM[lym] || 0) + 1; }
    let age = null;
    const rawBirth = iBirth >= 0 ? String(row[iBirth] ?? '').trim() : '';
    const maskY = rawBirth.match(/^(\d{2})\*{2,4}$/); // 해피나눔 마스킹(YY****) → 출생연도만 사용
    if (maskY) { const y = 1900 + Number(maskY[1]); age = new Date().getFullYear() - y; }
    else if (iBirth >= 0) { const b = parseAnyDate(row[iBirth]); if (b) age = Math.floor((new Date(nowK) - new Date(b + 'T00:00:00Z')) / 31557600000); }
    if (age == null && iAge >= 0) { const a = parseInt(String(row[iAge] || '').replace(/[^\d]/g, ''), 10); if (a > 0 && a < 120) age = a; }
    if (age != null) { const b = binAge(age); ageBins[b] = (ageBins[b] || 0) + 1; }
    if (iGender >= 0) { const g = normGender(row[iGender]); genderC[g] = (genderC[g] || 0) + 1; }
    if (iRegion >= 0) { const rg = normRegion(row[iRegion]); if (rg && rg !== '기타') regionC[rg] = (regionC[rg] || 0) + 1; }
  }
  const monthly = months.map(ym => [ym, joinM[ym] || 0, leaveM[ym] || 0]);
  const age = AGE_ORDER.filter(b => ageBins[b]).map(b => [b, ageBins[b]]).concat(Object.keys(ageBins).filter(b => !AGE_ORDER.includes(b)).map(b => [b, ageBins[b]]));
  const gender = ['여성', '남성', '무응답'].filter(g => genderC[g]).map(g => [g, genderC[g]]);
  const region = Object.entries(regionC).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const out = {
    ok: true, importedAt: new Date().toISOString(), source: srcName, total,
    monthly, age, gender, region,
    mapping: { 가입일: head[iJoin] || null, 탈퇴일: iLeave >= 0 ? head[iLeave] : null, 생년월일: iBirth >= 0 ? head[iBirth] : null, 나이: iAge >= 0 ? head[iAge] : null, 성별: iGender >= 0 ? head[iGender] : null, 지역: iRegion >= 0 ? head[iRegion] : null },
    skippedRows: warn
  };
  // 회원상태 열이 있으면 활동 조합원(정상) 수를 실총계로 사용 + 상태 구성 반환
  const iStatus = head.findIndex(h => /회원상태/.test(h));
  if (iStatus >= 0) {
    let act = 0, oth = 0;
    for (let r = 1; r < rows.length; r++) { const st = String((rows[r] || [])[iStatus] ?? '').trim(); if (st) st === '정상' ? act++ : oth++; }
    out.totalOverride = act; out.status = [['정상(활동)', act], ['기타·불능', oth]];
  }
  return out;
}

/* ── 요약 데이터 생성: 웹훅 집계 + CSV 백필 + 기준값 → 일별 친구 수 시리즈 ── */
function buildSummary() {
  const imported = history.imported || {};
  const agg = {}; // date -> {join, block}
  for (const e of events.log) {
    const d = kstDate(e.at);
    if (!d || imported[d]) continue;               // CSV 백필 일자는 공식 값 우선
    (agg[d] || (agg[d] = { join: 0, block: 0 }));
    if (e.event === 'added') agg[d].join++;
    else if (e.event === 'blocked') agg[d].block++;
  }
  for (const [d, r] of Object.entries(imported)) agg[d] = { join: r.join || 0, block: r.block || 0 };

  const dates = Object.keys(agg).sort();
  const base = config.baseline;
  // S(d): baseline일 이전까지 포함한 누적 순증감 (백필 날짜가 기준일 사이여도 계산 가능하게)
  const prefix = [];
  let run = 0;
  for (const d of dates) { run += agg[d].join - agg[d].block; prefix.push([d, run]); }
  const S = d => { let v = 0; for (const [dd, s] of prefix) { if (dd <= d) v = s; } return v; };

  const daily = dates.map(d => {
    const r = agg[d];
    return { date: d, join: r.join, block: r.block, net: r.join - r.block };
  });
  let friends = null;
  if (base && base.friends != null && base.friends > 0 && base.date) friends = base.friends + (prefix.length ? S(dates[dates.length - 1]) - S(base.date) : 0);
  if (friends != null) daily.forEach(r => { r.friends = imported[r.date] && imported[r.date].friends != null ? imported[r.date].friends : base.friends + (S(r.date) - S(base.date)); }); // 리포트가 준 당일 값 우선 — 기준값으로 미는 게 아니라
  const lastImport = history.lastImport || null;
  const out = {
    asOf: new Date().toISOString(),
    source: 'kakao-collector',
    channel_public_id: config.channelPublicId || null,
    baseline: base ? { date: base.date, friends: base.friends } : null,
    friends,
    needs_baseline: !friends,
    daily: daily.slice(-120),
    lastImport
  };
  if (manual.chat) out.chat = manual.chat;
  if (Array.isArray(manual.posts) && manual.posts.length) out.posts = manual.posts;
  const extra = load(path.join(DATA_DIR, 'extra.json'), {});
  if (extra.demo) out.demo = extra.demo;
  if (Array.isArray(extra.messages) && extra.messages.length) out.messages = extra.messages;
  if (Array.isArray(extra.sendsByWeek) && extra.sendsByWeek.length) out.sendsByWeek = extra.sendsByWeek;
  if (Array.isArray(extra.visits) && extra.visits.length) out.visits = extra.visits;
  return out;
}

/* ── CSV 파싱 (파트너센터 통계 백필용, 헤더 유연 매핑) ── */
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}
function parseDateCell(s) {
  s = String(s).trim();
  let m = s.match(/(\d{4})[.\-\s/년]+\s*(\d{1,2})[.\-\s/월]+\s*(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{2})[.\-\s/]\s*(\d{1,2})[.\-\s/]\s*(\d{1,2})$/);
  if (m) return `20${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function parseNumCell(s) {
  s = String(s).trim();
  if (!s || s === '-' || s === '–') return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : (neg ? -n : n);
}
function doImport(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return { error: 'CSV에 데이터 행이 없습니다.' };
  const head = rows[0].map(h => h.trim());
  const isFriendCount = h => /친구\s*수|누적\s*친구|전체\s*친구|친구\s*합계/.test(h) && !/(신규|추가|채팅|요청|탈퇴|차단|이탈|증가|감소|거부|순)/.test(h);
  const col = head.map(h => {
    if (!h) return null;
    if (/날짜|일자|date/i.test(h)) return 'date';
    if (/신규|추가|가입|유입|new/i.test(h)) return 'join';
    if (/차단|이탈|탈퇴|거부|block/i.test(h)) return 'block';
    if (/증감|순증|순감|net/i.test(h)) return 'net';
    if (isFriendCount(h) || /friend|total/i.test(h)) return 'friends';
    return null;
  });
  if (!col.includes('date')) return { error: '날짜 열을 찾지 못했습니다. 헤더에 날짜/일자 열이 있어야 합니다. (헤더: ' + head.join(' | ') + ')' };
  let count = 0, dmin = null, dmax = null, baseRow = null, friendsSeen = 0, friendsNonZero = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const rec = {};
    col.forEach((c, j) => { if (c) rec[c] = parseNumCell(r[j]); });
    rec.date = parseDateCell(r[col.indexOf('date')]);
    if (!rec.date) continue;
    if (rec.friends == null && rec.net != null && rec.join == null) { rec.join = rec.net; rec.block = 0; }
    const rowOut = { join: rec.join || 0, block: rec.block || 0 };
    if (rec.friends != null) { rowOut.friends = rec.friends; friendsSeen++; if (rec.friends > 0) friendsNonZero++; }
    history.imported[rec.date] = rowOut;
    if (rec.friends > 0 && (!baseRow || rec.date >= baseRow.date)) baseRow = { date: rec.date, friends: rec.friends };
    count++; if (!dmin || rec.date < dmin) dmin = rec.date; if (!dmax || rec.date > dmax) dmax = rec.date;
  }
  // 카카오 리포트에는 차단/탈퇴 열이 없다 — 전일 친구수와의 차이로 이탈 수를 역산해 채운다
  const ds = Object.keys(history.imported).filter(d => history.imported[d].friends != null).sort();
  for (let i = 1; i < ds.length; i++) {
    const a = history.imported[ds[i - 1]], b = history.imported[ds[i]];
    if (a.friends > 0 && !b.block) {
      const implied = (a.friends + (b.join || 0)) - b.friends;
      if (implied > 0) b.block = implied;
    }
  }
  if (baseRow) config.baseline = baseRow; // 친구수 열의 유효한(0 초과) 마지막 값만 기준으로 채택
  history.lastImport = { at: new Date().toISOString(), imported: count, range: dmin && dmax ? dmin + '~' + dmax : null, headers: head.filter(Boolean), warning: null };
  save(F.history, history); save(F.config, config);
  const warn = friendsSeen > 0 && friendsNonZero === 0
    ? "친구 수 열의 값이 전부 0입니다 — 파일에 '친구 수(누적)' 열이 빠졌거나 다른 통계의 파일일 수 있습니다. 카카오 비즈니스 > 통계 > 친구 통계 내려받기 파일인지 확인하세요."
    : null;
  if (warn) history.lastImport.warning = warn;
  save(F.history, history);
  return { imported: count, range: dmin && dmax ? `${dmin} ~ ${dmax}` : null, baseline: config.baseline, warning: warn, headers: head.filter(Boolean) };
}


function addVal(list, r) {
  const k = String(r[1] || '').trim(), v = parseNumCell(r[2]) || parseNumCell(r[1]) || 0;
  if (!k || !v) return list || [];
  const out = list ? list.filter(x => x[0] !== k) : [];
  out.push([k, v]);
  return out.sort((a, b) => b[1] - a[1]);
}
function groupWeeks(msgs) {
  const wk = {};
  msgs.forEach(m => {
    const d = parseDateCell(m.d) || m.d;
    const dt = new Date(d + 'T00:00:00Z');
    const Monday = new Date(dt); Monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    const key = String(Monday.getUTCMonth() + 1) + '/' + Math.ceil(Monday.getUTCDate() / 7) + '주';
    (wk[key] || (wk[key] = [key, 0, 0]));
    wk[key][1]++; wk[key][2] += m.c || 0;
  });
  return Object.values(wk).slice(-8);
}

/* ── 관리 페이지 (/admin) ── */
function adminHTML() {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>카카오 채널 수집기 · 관리</title><style>
:root{--ink:#233028;--pine:#2E6B4E;--tint:#E4EEE7;--amber:#E9A23B;--paper:#F3F4EF;--hair:rgba(35,48,40,.12);--clay:#C4674A}
*{box-sizing:border-box;margin:0;font-family:'Pretendard',-apple-system,'Malgun Gothic',sans-serif}
body{background:var(--paper);color:var(--ink);padding:34px 20px;font-size:14px;line-height:1.6}
.wrap{max-width:860px;margin:0 auto;display:grid;gap:16px}
h1{font-size:22px;letter-spacing:-.3px}h1 small{font-size:12px;color:#5C6B61;font-weight:400;display:block;margin-top:4px}
.card{background:#fff;border:1px solid var(--hair);border-radius:14px;padding:20px 22px;box-shadow:0 1px 2px rgba(35,48,40,.05),0 6px 20px rgba(35,48,40,.06)}
h2{font-size:15px;margin-bottom:10px;color:var(--pine)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
input[type=text],input[type=number]{padding:8px 12px;border:1px solid var(--hair);border-radius:8px;font-size:13px}
button{background:var(--pine);color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer}
button.ghost{background:#fff;color:var(--pine);border:1px solid var(--pine)}
.msg{font-size:12.5px;margin-top:8px}.msg.ok{color:var(--pine)}.msg.err{color:var(--clay)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:7px 8px;border-bottom:1px solid var(--hair);text-align:left}
th{color:#93A198;font-size:11px;letter-spacing:.4px}
.stat{display:flex;gap:18px;flex-wrap:wrap;font-size:13px}
.stat b{font-size:18px;color:var(--pine)}
a{color:var(--pine)}
code{background:var(--tint);padding:2px 6px;border-radius:6px;font-size:12px}
.step{font-size:12.5px;color:#5C6B61;margin-top:6px}
</style></head><body><div class="wrap">
<h1>카카오 채널 수집기 <small>허그인사회적협동조합 대시보드 연동 · 데이터는 data/ 폴더에 JSON으로 저장됩니다</small></h1>

<div class="card"><h2>현황</h2><div class="stat" id="stat">불러오는 중…</div><p class="step" id="lasttry"></p></div>

<div class="card"><h2>1 · 기준 친구 수 입력</h2>
<div class="row"><input type="number" id="friends" placeholder="예: 2134" style="width:140px">
<button onclick="saveBaseline()">저장</button></div>
<p class="step">파트너센터(카카오비즈니스 관리자) 통계에서 오늘의 친구 수를 확인해 입력하세요. 이후 웹훅 이벤트로 자동 가감됩니다.</p>
<div class="msg" id="m1"></div></div>

<div class="card"><h2>2 · 파트너센터 통계 백필 (선택)</h2>
<div class="row"><input type="file" id="csv" accept=".csv,.xlsx,.xls">
<button onclick="imp()">통계 파일 업로드</button></div>
<p class="step">파트너센터 &gt; 통계 &gt; 친구 통계를 엑셀로 내려받은 뒤, CSV로 저장해서 올리면 과거 일별 추이가 한 번에 채워집니다. 헤더에 날짜·친구수·신규·차단 열이 자동 인식됩니다.</p>
<div class="msg" id="m2"></div></div>

<div class="card"><h2>3 · 웹훅 상태</h2>
<div class="stat" id="webhook-stat"></div>
<p class="step">카카오 디벨로퍼스 [앱] &gt; [웹훅] &gt; [카카오톡 채널 웹훅]에 <code id="whurl"></code> 을 등록하세요. 최근 수신 이벤트:</p>
<table id="events"><thead><tr><th>시각(KST)</th><th>이벤트</th><th>사용자</th></tr></thead><tbody></tbody></table></div>

<div class="card"><h2>4 · 조합원 파일 업로드 (주간 갱신)</h2>
<div class="row"><input type="file" id="memfile" accept=".xlsx,.csv">
<button onclick="upMem()">업로드 · 자동 집계</button></div>
<p class="step">해피나눔 &gt; 조합원 정보 다운로드에서 받은 파일을 그대로 올리면 연령대·성별·지역·월별 증감이 자동 집계되어 대시보드에 즉시 반영됩니다. 주 1회만 올리면 됩니다.</p>
<div class="msg" id="m4"></div></div>

<div class="card"><h2>5 · 카카오 추가 통계 (선택)</h2>
<div class="row"><input type="file" id="extracsv" accept=".csv,.xls,.xlsx">
<button onclick="impExtra()">추가 통계 업로드</button></div>
<p class="step">파트너센터 메시지 통계(발송·클릭)나 친구 구성(성별·연령·지역·관심) CSV를 올리면 대시보드 카카오 탭의 메시지 성과·친구 구성 섹션이 실데이터로 채워집니다. 형식은 자동 인식합니다.</p>
<div class="msg" id="m5"></div></div>

<div class="card"><h2>설정 · 연결 테스트</h2>
<div class="row">
<input type="text" id="adminKey" placeholder="관리자 키(설정 시 필요)" style="width:180px">
<input type="text" id="restKey" placeholder="앱 REST API 키" style="width:200px">
<input type="text" id="secretKey" placeholder="클라이언트 시크릿(활성화 시 필수)" style="width:220px">
<input type="text" id="kakaoAdminKey" placeholder="카카오 대표 어드민 키(웹훅 검증)" style="width:220px">
<input type="text" id="channelId" placeholder="채널 프로필 ID(예: _xxxx)" style="width:150px">
<button class="ghost" onclick="saveConfig()">설정 저장</button>
<button onclick="connectTest()">카카오 로그인으로 연결 테스트</button></div>
<p class="step">REST API 키를 저장하고 카카오 디벨로퍼스 앱에 아래 두 URL을 등록한 뒤 연결 테스트를 누르면, 공식 API로 내 계정의 채널 관계가 조회됩니다.</p>
<p class="step">① 카카오 로그인 &gt; Redirect URI: <code id="redirurl"></code></p>
<p class="step">② 웹훅 &gt; 카카오톡 채널 웹훅: <code id="whurl2"></code></p>
<p class="step">카카오 어드민 키를 설정하면 웹훅 요청의 Authorization 헤더를 검증합니다. 공개 주소로 서버를 노출할 때는 반드시 설정하세요.</p>
<div class="msg" id="m3"></div></div>

</div>
<script>
const KEY = sessionStorage.getItem('adminKey') || '';
const H = () => (KEY ? { 'X-Admin-Key': KEY } : {});
function jq(r){return r.json().then(j=>{if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;});}
async function init(){
  try{
    const c = await jq(await fetch('/api/config',{headers:H()}));
    document.getElementById('kakaoAdminKey').placeholder = c.kakaoAdminKey ? '설정됨 (****'+c.kakaoAdminKey+')' : '카카오 대표 어드민 키(웹훅 검증)';
    document.getElementById('restKey').placeholder = c.restApiKey ? '설정됨 (****'+c.restApiKey.slice(-4)+')' : '앱 REST API 키';
    document.getElementById('secretKey').placeholder = c.clientSecret ? '설정됨 (****'+c.clientSecret+')' : '클라이언트 시크릿(활성화 시 필수)';
    const lt = c.lastOAuth;
    document.getElementById('lasttry').innerHTML = lt ? ('마지막 연결 시도 ['+new Date(lt.at).toLocaleString('ko-KR',{hour12:false})+'] '+(lt.ok?'<b style="color:var(--pine)">성공</b> · ':'<b style="color:var(--clay)">실패</b> · ')+lt.detail) : '아직 연결 시도 기록이 없습니다.';
    document.getElementById('channelId').value = c.channelPublicId || '';
    document.getElementById('redirurl').textContent = location.origin + '/oauth/callback';
    document.getElementById('whurl2').textContent = location.origin + '/webhook/kakao';
    const s = await jq(await fetch('/api/kakao/summary'));
    document.getElementById('stat').innerHTML =
      '<span>친구 수 <b>'+(s.friends==null?'미설정':s.friends.toLocaleString())+'명</b></span>'+
      '<span>데이터 <b>'+s.daily.length+'일</b></span>'+
      (s.baseline?'<span>기준 <b>'+s.baseline.date+'</b> · '+s.baseline.friends.toLocaleString()+'명</span>':'<span style="color:var(--clay)">기준 친구 수를 입력하세요</span>');
    const e = await jq(await fetch('/api/events',{headers:H()}));
    document.getElementById('webhook-stat').innerHTML = '<span>수신 이벤트 <b>'+e.total+'건</b></span><span>최근 <b>'+(e.last_at||'없음')+'</b></span>';
    document.querySelector('#events tbody').innerHTML = e.log.map(x=>'<tr><td>'+x.at+'</td><td>'+(x.event==='added'?'추가':'차단')+'</td><td>'+x.id+'</td></tr>').join('') || '<tr><td colspan="3">아직 수신된 웹훅이 없습니다</td></tr>';
    document.getElementById('whurl').textContent = location.origin + '/webhook/kakao';
  }catch(err){document.getElementById('stat').textContent='불러오기 실패: '+err.message;}
}
async function saveBaseline(){
  try{const j=await jq(await fetch('/api/config',{method:'POST',headers:{...H(),'Content-Type':'application/json'},body:JSON.stringify({baseline_friends:Number(document.getElementById('friends').value)})}));
  document.getElementById('m1').className='msg ok';document.getElementById('m1').textContent='저장 완료 · 기준일 '+j.baseline.date;init();}catch(e){document.getElementById('m1').className='msg err';document.getElementById('m1').textContent=e.message;}
}
async function imp(){
  const f=document.getElementById('csv').files[0];if(!f){document.getElementById('m2').className='msg err';document.getElementById('m2').textContent='CSV 파일을 선택하세요.';return;}
  try{
    const b=new Uint8Array(await f.arrayBuffer());let bin='';for(let i=0;i<b.length;i+=0x8000)bin+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));
    const j=await jq(await fetch('/api/import',{method:'POST',headers:{...H(),'Content-Type':'application/json'},body:JSON.stringify({name:f.name,dataBase64:btoa(bin)})}));
  document.getElementById('m2').className='msg ok';document.getElementById('m2').textContent=j.imported+'일치 가져옴 ('+j.range+') · 기준: '+JSON.stringify(j.baseline);init();}catch(e){document.getElementById('m2').className='msg err';document.getElementById('m2').textContent=e.message;}
}
async function saveConfig(){
  try{await jq(await fetch('/api/config',{method:'POST',headers:{...H(),'Content-Type':'application/json'},body:JSON.stringify({adminToken:document.getElementById('adminKey').value.trim()||undefined,restApiKey:document.getElementById('restKey').value.trim()||undefined,clientSecret:document.getElementById('secretKey').value.trim()||undefined,kakaoAdminKey:document.getElementById('kakaoAdminKey').value.trim()||undefined,channelPublicId:document.getElementById('channelId').value.trim()||undefined})}));
  document.getElementById('m3').className='msg ok';document.getElementById('m3').textContent='저장 완료';init();}catch(e){document.getElementById('m3').className='msg err';document.getElementById('m3').textContent=e.message;}
}
async function impExtra(){
  const f=document.getElementById('extracsv').files[0];if(!f){document.getElementById('m5').className='msg err';document.getElementById('m5').textContent='CSV·엑셀 파일을 선택하세요.';return;}
  try{
    const buf=new Uint8Array(await f.arrayBuffer());let bin='';for(let i=0;i<buf.length;i+=0x8000)bin+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));
    const r=await jq(await fetch('/api/kakao/extra',{method:'POST',headers:{...H(),'Content-Type':'application/json'},body:JSON.stringify({name:f.name,dataBase64:btoa(bin)})}));
    document.getElementById('m5').className='msg ok';
    document.getElementById('m5').textContent='반영 완료 · 구성통계:'+(r.demo?'있음':'없음')+' · 메시지:'+r.messages+'건 · 주간추이:'+r.weeks+'주';
  }catch(e){document.getElementById('m5').className='msg err';document.getElementById('m5').textContent=e.message;}
}
function connectTest(){
  const rest=(document.getElementById('restKey').value.trim())||'';
  if(!rest){alert('먼저 앱의 REST API 키를 입력하고 설정 저장을 누르세요.');return;}
  location.href='https://kauth.kakao.com/oauth/authorize?response_type=code&client_id='+encodeURIComponent(rest)+'&redirect_uri='+encodeURIComponent(location.origin+'/oauth/callback')+'&scope=plusfriends';
}
async function upMem(){
  const f=document.getElementById('memfile').files[0];if(!f){document.getElementById('m4').className='msg err';document.getElementById('m4').textContent='엑셀(.xlsx) 또는 CSV 파일을 선택하세요.';return;}
  try{
    const buf=new Uint8Array(await f.arrayBuffer());let bin='';for(let i=0;i<buf.length;i+=0x8000)bin+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));
    const j=await jq(await fetch('/api/members/import',{method:'POST',headers:{...H(),'Content-Type':'application/json'},body:JSON.stringify({name:f.name,dataBase64:btoa(bin)})}));
    document.getElementById('m4').className='msg ok';
    document.getElementById('m4').innerHTML='집계 완료 · 총 <b>'+j.total.toLocaleString()+'명</b> (연령 '+j.age.length+'개층 · 지역 '+j.region.length+'곳 · 스킵 '+j.skippedRows+'행) — 대시보드에 반영되었습니다.';
  }catch(e){document.getElementById('m4').className='msg err';document.getElementById('m4').textContent=e.message;}
}
init();
</script></body></html>`;
}

/* ── HTTP 서버 ── */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5 * 1024 * 1024) reject(new Error('too large')); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function authOk(req) {
  return !config.adminToken || req.headers['x-admin-key'] === config.adminToken;
}
function findDashboard() {
  for (const p of [path.join(__dirname, 'huggin-dashboard.html'), path.join(__dirname, '..', 'huggin-dashboard.html')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {});

    /* 카카오 웹훅 수신 (공식 API) */
    if (p === '/webhook/kakao' && req.method === 'POST') {
      if (config.kakaoAdminKey) {
        const auth = (req.headers['authorization'] || '').replace(/^KakaoAK\s+/i, '').trim();
        if (auth !== config.kakaoAdminKey) return json(res, 401, { error: 'invalid admin key' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!['added', 'blocked'].includes(body.event)) return json(res, 200, { ignored: true });
      if (config.channelPublicId && body.channel_public_id && body.channel_public_id !== config.channelPublicId) return json(res, 200, { ignored: true });
      const rid = req.headers['x-kakao-resource-id'] || '';
      if (rid && events.seen.includes(rid)) return json(res, 200, { dedup: true });
      if (rid) { events.seen.push(rid); if (events.seen.length > 5000) events.seen = events.seen.slice(-3000); }
      const idHash = body.id ? crypto.createHash('sha256').update(String(body.id)).digest('hex').slice(0, 8) : '-';
      events.log.push({ at: body.updated_at || new Date().toISOString(), event: body.event, id: '#' + idHash });
      if (events.log.length > 20000) events.log = events.log.slice(-15000);
      save(F.events, events);
      return json(res, 200, { ok: true });
    }

    /* 대시보드가 읽는 요약 데이터 */
    if (p === '/api/kakao/summary' && req.method === 'GET') return json(res, 200, buildSummary());

    /* 관리 API */
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, {
      baseline: config.baseline,
      kakaoAdminKey: config.kakaoAdminKey ? '****' + config.kakaoAdminKey.slice(-4) : '',
      restApiKey: config.restApiKey || '',
      clientSecret: config.clientSecret ? '****' + config.clientSecret.slice(-4) : '',
      channelPublicId: config.channelPublicId || '',
      adminTokenSet: !!config.adminToken,
      lastOAuth: oauthLog.last
    });
    if (p === '/api/config' && req.method === 'POST') {
      if (!authOk(req)) return json(res, 401, { error: '관리자 키 불일치' });
      const b = JSON.parse((await readBody(req)) || '{}');
      if (b.baseline_friends != null && !isNaN(b.baseline_friends)) config.baseline = { date: kstDate(new Date().toISOString()), friends: Number(b.baseline_friends) };
      if (typeof b.kakaoAdminKey === 'string') config.kakaoAdminKey = b.kakaoAdminKey.trim();
      if (typeof b.restApiKey === 'string') config.restApiKey = b.restApiKey.trim();
      if (typeof b.clientSecret === 'string') config.clientSecret = b.clientSecret.trim();
      if (typeof b.channelPublicId === 'string') config.channelPublicId = b.channelPublicId.trim();
      if (typeof b.adminToken === 'string') config.adminToken = b.adminToken.trim();
      save(F.config, config);
      return json(res, 200, { ok: true, baseline: config.baseline });
    }
    if (p === '/api/import' && req.method === 'POST') {
      if (!authOk(req)) return json(res, 401, { error: '관리자 키 불일치' });
      const b = JSON.parse((await readBody(req)) || '{}');
      const r = doImport(b.dataBase64 ? csvFromSheet(Buffer.from(b.dataBase64, 'base64'), b.name) : (b.csv || ''));
      if (r.error) return json(res, 400, r);
      return json(res, 200, r);
    }
    if (p === '/api/events' && req.method === 'GET') {
      if (!authOk(req)) return json(res, 401, { error: '관리자 키 불일치' });
      const last = events.log[events.log.length - 1];
      return json(res, 200, {
        total: events.log.length,
        last_at: last ? kstDate(last.at) : null,
        log: events.log.slice(-15).reverse().map(e => ({ at: (kstDate(e.at) || '?') + ' ' + new Date(e.at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }), event: e.event, id: e.id }))
      });
    }

    /* 승인 직행: 버튼·페이지 없이 이 주소만 열면 카카오 로그인 화면으로 이동 */
    if (p === '/oauth/start' && req.method === 'GET') {
      if (!config.restApiKey) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
      const proto = String(req.headers['x-forwarded-proto'] || 'http').trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + PORT).trim();
      const redirect_uri = proto + '://' + host + '/oauth/callback';
      res.writeHead(302, { Location: 'https://kauth.kakao.com/oauth/authorize?response_type=code&client_id=' + encodeURIComponent(config.restApiKey) + '&redirect_uri=' + encodeURIComponent(redirect_uri) + '&scope=plusfriends' });
      return res.end();
    }

    /* 카카오 로그인 연결 테스트: plusfriends 동의 → 채널 관계 조회(공식 API 실호환 확인) */
    if (p === '/oauth/callback' && req.method === 'GET') {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + PORT).trim();
      const redirect_uri = proto + '://' + host + '/oauth/callback';
      const eDesc = u.searchParams.get('error_description') || u.searchParams.get('error');
      const code = u.searchParams.get('code');
      let body;
      if (!config.restApiKey) {
        logOAuth(false, 'REST API 키 미저장 상태에서 테스트 시도');
        body = '<p>먼저 <a href="/admin">관리 페이지</a>의 설정에서 앱의 <b>REST API 키</b>를 저장한 뒤 다시 시도하세요.</p>';
      } else if (eDesc) {
        const h = oauthHint(eDesc);
        logOAuth(false, '승인 단계 오류: ' + eDesc);
        body = '<p><b>승인 단계 오류</b></p><p>원인: <b>' + esc(h.why) + '</b></p><p>해결: ' + esc(h.fix) + '</p><p class="step">원문 오류: <code>' + esc(eDesc) + '</code></p>';
      } else {
        try {
          const params = { grant_type: 'authorization_code', client_id: config.restApiKey, redirect_uri, code };
          if (config.clientSecret) params.client_secret = config.clientSecret;
          const tRes = await fetch('https://kauth.kakao.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(params) });
          const tok = await tRes.json();
          if (!tok.access_token) throw new Error(tok.error_description || tok.error || '토큰 발급 실패');
          const cRes = await fetch('https://kapi.kakao.com/v2/api/talk/channels', { headers: { Authorization: 'Bearer ' + tok.access_token } });
          const ch = await cRes.json();
          if (ch.code || ch.msg) throw new Error(ch.msg || ('카카오 API 오류 코드 ' + ch.code));
          logOAuth(true, '연결 성공 · 채널 관계 ' + ((ch.channels || []).length) + '건 반환');
          const rows = (ch.channels || []).map(c => `<tr><td>${esc(c.channel_public_id)}</td><td>${c.relation === 'ADDED' ? '<b>친구 상태</b>' : c.relation === 'BLOCKED' ? '차단 상태' : '없음'}</td><td>${esc(c.created_at || '-')}</td></tr>`).join('') || '<tr><td colspan="3">반환된 채널 관계가 없습니다 — 앱에 카카오톡 채널 연결(심사 완료) 또는 대표 채널 설정이 필요합니다.</td></tr>';
          body = `<p style="color:var(--pine);font-weight:700">✔ 연결 성공 — 카카오 공식 API(채널 관계 조회)로 내 계정의 채널 관계를 조회했습니다.</p>
          <table><thead><tr><th>채널 프로필 ID</th><th>관계</th><th>추가 시각</th></tr></thead><tbody>${rows}</tbody></table>
          <p class="step">이 API는 <b>동의한 사용자 개인</b> 단위입니다. 채널 전체 통계(친구 수 증감·도달)는 공개 API가 없으므로 웹훅 수집 + CSV 백필로 구축됩니다.</p>`;
        } catch (err) {
          const msg = String(err.message || err);
          const h = oauthHint(msg);
          logOAuth(false, '연결 실패: ' + msg);
          body = '<p><b>연결 실패</b></p><p>원인: <b>' + esc(h.why) + '</b></p><p>해결: ' + esc(h.fix) + '</p><p class="step">원문 오류: <code>' + esc(msg) + '</code></p>';
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>카카오 연결 테스트</title><style>:root{--ink:#233028;--pine:#2E6B4E;--hair:rgba(35,48,40,.12)}body{font-family:'Pretendard',-apple-system,'Malgun Gothic',sans-serif;background:#F3F4EF;color:var(--ink);padding:40px 20px}main{max-width:640px;margin:0 auto;background:#fff;border:1px solid var(--hair);border-radius:14px;padding:28px}h1{font-size:18px;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}th,td{padding:8px;border-bottom:1px solid rgba(35,48,40,.1);text-align:left}th{color:#93A198;font-size:11px}code{background:#E4EEE7;padding:2px 6px;border-radius:6px;font-size:12px}.step{font-size:12.5px;color:#5C6B61}a{color:var(--pine)}p{margin:8px 0;line-height:1.6}</style></head><body><main><h1>카카오 연결 테스트</h1>${body}<p style="margin-top:18px"><a href="/admin">← 관리 페이지로 돌아가기</a></p></main></body></html>`);
    }

    /* 조합원 파일 집계 (해피나눔 다운로드 → 업로드) */
    if (p === '/api/members/import' && req.method === 'POST') {
      if (!authOk(req)) return json(res, 401, { error: '관리자 키 불일치' });
      const b = JSON.parse((await readBody(req)) || '{}');
      try {
        let rows;
        if (b.dataBase64) rows = parseCSV(csvFromSheet(Buffer.from(b.dataBase64, 'base64'), b.name));
        else rows = parseCSV(b.csv || '');
        membersState = aggregateMembers(rows, b.name || 'upload');
        save(F.members, membersState);
        return json(res, 200, membersState);
      } catch (e) { return json(res, 400, { error: String(e && e.message || e) }); }
    }
    if (p === '/api/members/summary' && req.method === 'GET') return json(res, 200, membersState || { ok: false });

    /* 카카오 추가 통계 (메시지 성과 · 친구 구성) — CSV 업로드로 반영 */
    if (p === '/api/xlsx-to-csv' && req.method === 'POST') {
      if (!authOk(req)) return json(res, 401, { error: '관리자 키 불일치' });
      const b = JSON.parse((await readBody(req)) || '{}');
      try {
        const rows = readXlsxRows(Buffer.from(b.dataBase64, 'base64'));
        const csv = rows.map(r => r.map(c => { const v = String(c ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n');
        return json(res, 200, { csv });
      } catch (e) { return json(res, 400, { error: String(e && e.message || e) }); }
    }
    if (p === '/api/kakao/extra' && req.method === 'POST') {
      if (!authOk(req)) return json(res, 401, { error: '관리자 키 불일치' });
      const b = JSON.parse((await readBody(req)) || '{}');
      try {
        const csvText = b.dataBase64 ? csvFromSheet(Buffer.from(b.dataBase64, 'base64'), b.name) : (b.csv || '');
        const rows = parseCSV(csvText);
        if (rows.length < 2) throw new Error('CSV에 데이터 행이 없습니다');
        const head = rows[0].map(h => h.trim());
        const isDate = h => parseDateCell(h) || /^\d{1,2}\/\d{1,2}$/.test(h);
        const wideMsg = head.filter(isDate).length >= 3; // 열 자체가 날짜 = 넓은 형식
        const extra = load(path.join(DATA_DIR, 'extra.json'), {});
        if (wideMsg) {
          const dates = head.filter(isDate);
          const rowByLabel = {};
          rows.slice(1).forEach(r => { if (r[0]) rowByLabel[String(r[0]).trim()] = r; });
          const pick = re => { const r = Object.keys(rowByLabel).find(k => re.test(k)); return r ? dates.map((_, i) => parseNumCell(rowByLabel[r][head.indexOf(head.filter(isDate)[i])] ?? rowByLabel[r][i + 1])).map(v => v || 0) : null; };
          const sent = pick(/발송|전달|전송|sent/), clicks = pick(/클릭|click/);
          const msgs = dates.map((h, i) => ({ d: h, s: (sent && sent[i]) || 0, c: (clicks && clicks[i]) || 0 }));
          extra.sendsByWeek = groupWeeks(msgs);
        } else {
          for (let i = 1; i < rows.length; i++) {
            const r = rows[i] || [];
            const cat = String(r[0] || '').trim();
            if (/메시지|발송|클릭/.test(cat)) continue;
            if (/^성별|성별$/.test(cat) || /^(여성|남성|무응답)/.test(String(r[1] || ''))) {
              extra.demo = extra.demo || {}; extra.demo.gender = addVal(extra.demo.gender, r);
            } else if (/연령/.test(cat)) { extra.demo = extra.demo || {}; extra.demo.age = addVal(extra.demo.age, r); }
            else if (/지역|거주/.test(cat)) { extra.demo = extra.demo || {}; extra.demo.region = addVal(extra.demo.region, r); }
            else if (/관심|자녀|취향|프로그램/.test(cat)) { extra.demo = extra.demo || {}; extra.demo.interest = addVal(extra.demo.interest, r); }
            else if (/방문|조회/.test(cat)) { extra.visits = addVal(extra.visits, r); }
            else if (/^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})/.test(cat) && r.length >= 3) { // 긴 형식 메시지: 날짜,제목,발송,클릭
              extra.messages = extra.messages || [];
              extra.messages.push([String(r[1] || cat), cat, parseNumCell(r[2]) || 0, parseNumCell(r[3]) || 0]);
              extra.messages.sort((a, b2) => (a[1] < b2[1] ? 1 : -1));
              extra.messages = extra.messages.slice(0, 10);
            }
          }
        }
        extra.updatedAt = new Date().toISOString();
        save(path.join(DATA_DIR, 'extra.json'), extra);
        return json(res, 200, { ok: true, demo: !!extra.demo, messages: (extra.messages || []).length, weeks: (extra.sendsByWeek || []).length });
      } catch (e) { return json(res, 400, { error: String(e && e.message || e) }); }
    }

    /* 정적: 관리 페이지 & 대시보드 */
    if (p === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(adminHTML());
    }
    if (p === '/' || p === '/index.html') {
      const f = findDashboard();
      if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('huggin-dashboard.html 파일을 server.js와 같은 폴더(또는 상위 폴더)에 두세요.'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(f));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log('┌────────────────────────────────────────────────────┐');
  console.log('│  허그인 카카오 채널 수집기가 실행되었습니다.        ');
  console.log('│  대시보드  http://localhost:' + PORT + '/           ');
  console.log('│  관리      http://localhost:' + PORT + '/admin      ');
  console.log('│  웹훅     POST /webhook/kakao                      ');
  console.log('└────────────────────────────────────────────────────┘');
});
