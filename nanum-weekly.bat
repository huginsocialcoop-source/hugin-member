@echo off
rem 해피나눔 조합원 파일 주간 업로드 — 파일을 nanum-weekly 폴더에 넣고 이 배치를 실행(또는 예약)
cd /d %~dp0
node nanum-weekly.js
pause
