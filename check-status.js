#!/usr/bin/env node
'use strict';
/* 예약 작업·수집 상태 점검 — node check-status.js  (Windows 전용) */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = __dirname;
const ok = s => console.log('  ✔ ' + s);
const warn = s => console.log('  ⚠ ' + s);
const bad = s => console.log('  ✕ ' + s);
function taskInfo(name) {
  try {
    const out = execSync(`schtasks /query /tn "${name}" /v /fo list`, { encoding: 'utf8' });
    const get = k => (out.split('\n').find(l => l.includes(k)) || '').split(':').slice(1).join(':').trim();
    return { exists: true, lastRun: get('마지막 실행 시간') || get('Last Run Time'), result: get('마지막 결과') || get('Last Result'), next: get('다음 실행 시간') || get('Next Run Time') };
  } catch (e) { return { exists: false }; }
}
function getJSON(url) {
  return new Promise(res => { const mod = url.startsWith('https') ? require('https') : http; mod.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } }); }).on('error', () => res(null)); });
}
(async () => {
  console.log('\n═══ 허그인 대시보드 · 주간 자동화 점검 ═══\n');
  for (const [name, label] of [['허그인 채널통계', '카카오 채널 (목 17:00)'], ['허그인 조합원수집', '해피나눔 (목 17:30)'], ['허그인 수집기', '수집기 서버 (부팅 시)']]) {
    const t = taskInfo(name);
    if (!t.exists) bad(`${label}: 예약 없음 — setup-windows.bat 재실행 필요`);
    else ok(`${label}: 예약 있음 · 다음 실행 ${t.next} · 마지막 결과 코드 ${t.result || '-'}${t.result === '0' ? '(성공)' : t.result ? '(오류)' : ''}`);
  }
  const s = await getJSON('http://localhost:8787/api/kakao/summary');
  if (!s) bad('수집기 서버 응답 없음 — node server.js 가 실행 중인지 확인');
  else {
    ok(`수집기 정상 · 채널 친구 ${s.friends ?? '기준 미설정'}명 · 일별 ${s.daily.length}일치`);
    const li = s.lastImport;
    if (li) ok(`카카오 리포트 마지막 반영: ${new Date(li.at).toLocaleString('ko-KR', { hour12: false })} (${li.imported}일치)`);
    else warn('카카오 리포트 업로드 기록 없음 — 관리 페이지에서 리포트 파일 업로드 대기 중');
  }
  const m = await getJSON('http://localhost:8787/api/members/summary');
  if (m && m.ok) ok(`조합원 파일 반영: 총 ${m.total.toLocaleString()}명 (${new Date(m.importedAt).toLocaleString('ko-KR', { hour12: false })})`);
  else warn('조합원 파일 미반영 — nanum-weekly/ 폴더에 파일을 넣고 node nanum-weekly.js 실행 대기');
  const cred = fs.existsSync(path.join(ROOT, 'data', 'nanum-credentials.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nanum-credentials.json'), 'utf8')) : null;
  if (cred && cred.id && !String(cred.id).includes('여기에')) ok('해피나눔 자격 증명 저장됨 — 매주 목 17:30 무인 수집 가능');
  else bad('해피나눔 자격 증명 미설정 — node nanum-auto.js 첫 실행에서 입력 필요');
  const events = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'events.json'), 'utf8'));
  ok(`웹훅 수신 이벤트 누적 ${events.log.length}건${events.log.length ? '' : ' (웹훅 미연결 — 주간 리포트 방식으로 운영 중)'}`);
  console.log('\n  문제가 보이면 해당 항목의 안내대로 조치 후 다시 node check-status.js\n');
})();
