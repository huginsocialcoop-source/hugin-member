@echo off
chcp 65001 >nul
title 허그인 대시보드 자동화 설치
cd /d %~dp0
echo ═══════════════════════════════════════════════
echo   허그인 카카오 채널 + 해피나눔 · 주간 자동화 설치
echo   (매주 목요일 17:00 카카오 / 17:30 해피나눔)
echo   ※ PC가 꺼져 있던 주는 켜는 즉시 자동 보정 실행
echo ═══════════════════════════════════════════════
echo.
echo [1/5] Node.js 확인
where node >nul 2>nul
if errorlevel 1 (
  echo   ✕ Node.js 미설치 — https://nodejs.org 에서 LTS 설치 후 이 파일을 다시 실행하세요.
  pause & exit /b 1
)
node -v
echo.
echo [2/5] puppeteer-core 설치 (1회, 수 분 소요)
if not exist package.json call npm init -y >nul 2>nul
call npm install puppeteer-core --no-fund --no-audit
if errorlevel 1 ( echo   ✕ 설치 실패 — 인터넷 연결을 확인하세요. & pause & exit /b 1 )
echo.
echo [3/5] 자격 증명 입력 (해피나눔 — 최초 1회, 이 PC에만 저장)
if exist "data\nanum-credentials.json" findstr /c:"여기에" "data\nanum-credentials.json" >nul 2>nul
if not exist "data\nanum-credentials.json" goto nanum_need
findstr /c:"여기에" "data\nanum-credentials.json" >nul 2>nul
if not errorlevel 1 goto nanum_need
goto nanum_done
:nanum_need
echo   아래에 해피나눔 아이디·비밀번호를 입력하세요 (화면·파일에만 저장, 채팅 전송 금지)
node prompt-credentials.js
if errorlevel 1 ( echo   ✕ 자격 증명 저장 실패 — 다시 실행해 주세요. & pause & exit /b 1 )
:nanum_done
echo   자격 증명 준비 완료.
echo.
echo [3.5/5] 파트너센터 최초 로그인 (세션 저장)
echo   지금 열리는 Chrome 창에서 카카오 계정으로 로그인하세요(기기 인증 포함).
call node kakao-channel-auto.js --login
echo.
echo [4/5] 주간 예약 등록 — 목 17:00 카카오 / 목 17:30 해피나눔 (놓친 실행 자동 보정)
powershell -NoProfile -Command "(Get-Content 'tasks\task-kakao.xml' -Raw) -replace '__DIR__','%~dp0' | Set-Content '%TEMP%\huggin-kakao.xml' -Encoding UTF8"
schtasks /create /f /tn "허그인 채널통계" /xml "%TEMP%\huggin-kakao.xml"
powershell -NoProfile -Command "(Get-Content 'tasks\task-nanum.xml' -Raw) -replace '__DIR__','%~dp0' | Set-Content '%TEMP%\huggin-nanum.xml' -Encoding UTF8"
schtasks /create /f /tn "허그인 조합원수집" /xml "%TEMP%\huggin-nanum.xml"
echo.
echo [5/5] 수집기 서버 상주 등록 (부팅/로그온 시 자동 시작)
schtasks /create /f /tn "허그인 수집기" /tr "node \"%~dp0server.js\"" /sc onlogon
echo.
echo ═══════════════════════════════════════════════
echo   완료! 매주 목요일 17:00 카카오 / 17:30 해피나눔 자동 수집.
echo   PC가 꺼져 있던 주는 다음 켜짐 즉시 자동 보정 실행됩니다.
echo   대시보드: http://localhost:8787
echo ═══════════════════════════════════════════════
pause
