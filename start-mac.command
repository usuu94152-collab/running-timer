#!/bin/bash
# 러닝 타이머 로컬 서버 (macOS): 더블클릭해서 실행
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 이 필요합니다: https://www.python.org/downloads/ 에서 설치한 뒤 다시 실행하세요."
  open "https://www.python.org/downloads/"
  read -r -p "엔터를 누르면 닫힙니다…"
  exit 1
fi
python3 -c "import openpyxl" 2>/dev/null \
  || python3 -m pip install --user openpyxl \
  || python3 -m pip install --user --break-system-packages openpyxl
python3 server/running_server.py "$@"
