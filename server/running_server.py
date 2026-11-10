#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
러닝 타이머 로컬 서버: 선생님 컴퓨터의 엑셀 파일에 기록을 저장한다.

    python server/running_server.py [--port 8000] [--data 폴더] [--no-browser]

이 컴퓨터가 러닝 타이머 웹페이지를 띄워 주고, 같은 와이파이의 태블릿·휴대폰이
http://<이 컴퓨터 IP>:8000 으로 접속해 측정하면 기록이 이 컴퓨터에 저장된다.

  기록/학생명단.xlsx         선생님이 입력 (이름, 생년월일 [, 학년, 반, 번호])
  기록/러닝기록.xlsx         자동 생성: 최고기록 · 기록 탭
  기록/백업-기록원본.jsonl    모든 측정의 원본 (엑셀 파일이 열려 있어도 여기엔 바로 저장)

사용법은 LOCAL-SERVER.md 참고.
"""
import argparse
import datetime as dt
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    import openpyxl
    from openpyxl.styles import Font, PatternFill
except ImportError:
    sys.exit('openpyxl 이 필요합니다. 다음 명령으로 설치하세요:\n    python -m pip install --user openpyxl')

APP_DIR = Path(__file__).resolve().parent.parent
COURSES = ['301번 버스', '지그재그', '이어달리기', '장애물']
ROSTER_FILE = '학생명단.xlsx'
BOOK_FILE = '러닝기록.xlsx'
JOURNAL_FILE = '백업-기록원본.jsonl'
EXCLUDED_FILE = '백업-제외목록.json'
RECORD_HEADERS = ['측정일시', '학년', '반', '번호', '이름', '코스', '기록(초)', '목표(초)', '결과', '랩(초)', '제외', '기록ID']
NOT_FOUND = '학생명단에서 찾을 수 없어요. 이름과 생년월일을 다시 확인해 주세요.'
LOCKED = f'{BOOK_FILE} 파일이 엑셀에서 열려 있어 저장을 기다리는 중이에요. 파일을 닫으면 자동으로 저장돼요.'
HEAD_FONT = Font(bold=True)
HEAD_FILL = PatternFill('solid', fgColor='E8F0FE')


class RosterError(Exception):
    pass


# ================= 값 정리 =================

def norm_name(v):
    return re.sub(r'\s', '', '' if v is None else str(v))


def cell(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def as_num(v):
    """'3' → 3 (엑셀에서 숫자로 정렬되도록)"""
    return int(v) if isinstance(v, str) and v.isdigit() else v


def birth_key(v):
    """생년월일 → YYMMDD. 120305, 20120305, 2012-03-05, 2012.3.5, 날짜 셀 모두 같은 값"""
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime('%y%m%d')
    s = cell(v)
    if not s:
        return ''
    parts = [p for p in re.split(r'\D+', s) if p]
    if len(parts) == 3:
        return parts[0][-2:].zfill(2) + parts[1].zfill(2)[-2:] + parts[2].zfill(2)[-2:]
    d = re.sub(r'\D', '', s)
    if len(d) == 8:
        d = d[2:]
    if len(d) == 5:          # 숫자 셀에서 앞자리 0이 빠진 경우 (090101 → 90101)
        d = '0' + d
    return d if len(d) == 6 else ''


def header_cols(row):
    c = {'name': -1, 'birth': -1, 'grade': -1, 'cls': -1, 'num': -1}
    for i, v in enumerate(row):
        h = norm_name(v)
        if c['name'] < 0 and re.fullmatch(r'이름|성명|학생명|학생이름', h):
            c['name'] = i
        elif c['birth'] < 0 and re.search(r'생년월일|생일', h):
            c['birth'] = i
        elif c['grade'] < 0 and h == '학년':
            c['grade'] = i
        elif c['cls'] < 0 and h == '반':
            c['cls'] = i
        elif c['num'] < 0 and re.fullmatch(r'번호|번', h):
            c['num'] = i
    return c


def label(st):
    return ' '.join(x for x in (st['grade'] and st['grade'] + '학년', st['cls'] and st['cls'] + '반',
                                st['num'] and st['num'] + '번') if x)


def short_time(iso):
    try:
        t = dt.datetime.fromisoformat(iso)
        return f'{t.month}/{t.day} {t:%H:%M}'
    except (TypeError, ValueError):
        return ''


def style_head(ws, width):
    for c in ws[1][:width]:
        c.font, c.fill = HEAD_FONT, HEAD_FILL
    ws.freeze_panes = 'A2'


# ================= 저장소 =================

class Store:
    """백업-기록원본.jsonl 이 원본이고, 러닝기록.xlsx 는 그 내용으로 매번 새로 만든다.
    그래서 엑셀이 파일을 잠그거나 열어 둔 채 덮어써도 기록은 사라지지 않는다."""

    def __init__(self, data_dir):
        self.dir = Path(data_dir).resolve()
        self.dir.mkdir(parents=True, exist_ok=True)
        self.roster_path = self.dir / ROSTER_FILE
        self.book_path = self.dir / BOOK_FILE
        self.journal_path = self.dir / JOURNAL_FILE
        self.excluded_path = self.dir / EXCLUDED_FILE
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.records, self.ids, self.excluded = [], set(), set()
        self.version, self.written_version = 1, 0
        self.book_error = ''
        self.book_mtime = None
        self.saved_at = ''
        self._roster = (None, [])
        self._load()
        if not self.roster_path.exists():
            self._make_roster()

    # ---------- 파일 ----------
    def _load(self):
        if self.journal_path.exists():
            with open(self.journal_path, encoding='utf-8') as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(r, dict) and r.get('id') and r['id'] not in self.ids:
                        self.records.append(r)
                        self.ids.add(r['id'])
        try:
            self.excluded = set(json.loads(self.excluded_path.read_text('utf-8')))
        except (OSError, ValueError, TypeError):
            pass

    def _make_roster(self):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = '학생명단'
        ws.append(['학년', '반', '번호', '이름', '생년월일'])
        ws.append([3, 1, 1, '홍길동', '120305'])
        for row in ws.iter_rows(min_col=5, max_col=5):
            for c in row:
                c.number_format = '@'          # 생년월일 앞자리 0 보존
        style_head(ws, 5)
        for col, w in zip('ABCDE', (8, 8, 8, 14, 14)):
            ws.column_dimensions[col].width = w
        wb.save(self.roster_path)

    def _save_excluded(self):
        tmp = self.excluded_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(sorted(self.excluded), ensure_ascii=False), 'utf-8')
        os.replace(tmp, self.excluded_path)

    # ---------- 학생명단 ----------
    def roster(self):
        try:
            mtime = self.roster_path.stat().st_mtime
        except OSError:
            raise RosterError(f'{ROSTER_FILE} 파일이 없어요 ({self.roster_path}).')
        if self._roster[0] == mtime:
            return self._roster[1]
        try:
            wb = openpyxl.load_workbook(self.roster_path, read_only=True, data_only=True)
            try:
                ws = wb['학생명단'] if '학생명단' in wb.sheetnames else wb.worksheets[0]
                rows = [list(r) for r in ws.iter_rows(values_only=True)]
            finally:
                wb.close()
        except Exception as e:
            if self._roster[0] is not None:   # 엑셀이 저장하는 중 등: 직전 명단으로 계속
                return self._roster[1]
            raise RosterError(f'{ROSTER_FILE} 을(를) 읽을 수 없어요: {e}')
        for i, row in enumerate(rows[:10]):
            c = header_cols(row)
            if c['name'] < 0 or c['birth'] < 0:
                continue
            out = []
            for r in rows[i + 1:]:
                get = lambda k: r[c[k]] if 0 <= c[k] < len(r) else None
                name, birth = norm_name(get('name')), birth_key(get('birth'))
                if name and birth:
                    out.append({'name': name, 'birth': birth, 'grade': cell(get('grade')),
                                'cls': cell(get('cls')), 'num': cell(get('num'))})
            self._roster = (mtime, out)
            return out
        raise RosterError(f'{ROSTER_FILE} 첫 줄에 "이름"과 "생년월일" 열이 필요해요.')

    def find(self, p):
        name, birth = norm_name(p.get('name')), birth_key(p.get('birth'))
        if not name or not birth:
            return None
        return next((s for s in self.roster() if s['name'] == name and s['birth'] == birth), None)

    # ---------- 기록 ----------
    def active(self):
        return [r for r in self.records if r['id'] not in self.excluded]

    def summary(self, st):
        mine = [r for r in self.active() if r['name'] == st['name'] and r['birth'] == st['birth']]
        best = {}
        for r in mine:
            b = best.get(r['course'])
            if not b or r['sec'] < b['sec']:
                best[r['course']] = {'sec': r['sec'], 'result': r['result'], 'target': r['target']}
        recent = [{'at': short_time(r['at']), 'course': r['course'], 'sec': r['sec'], 'result': r['result']}
                  for r in reversed(mine[-10:])]
        return {'count': len(mine), 'best': best, 'recent': recent}

    def best_table(self):
        recs = self.active()
        courses = list(COURSES)
        for r in recs:
            if r['course'] not in courses:
                courses.append(r['course'])
        stats = {}
        for r in recs:
            s = stats.setdefault((r['name'], r['birth']), {'best': {}, 'count': 0, 'last': ''})
            s['count'] += 1
            s['last'] = max(s['last'], r['at'])
            if r['course'] not in s['best'] or r['sec'] < s['best'][r['course']]:
                s['best'][r['course']] = r['sec']
        try:
            roster = self.roster()
        except RosterError:
            roster = []
        rows = []
        for st in roster:
            s = stats.get((st['name'], st['birth']), {'best': {}, 'count': 0, 'last': ''})
            rows.append({'grade': st['grade'], 'cls': st['cls'], 'num': st['num'], 'name': st['name'],
                         'best': s['best'], 'count': s['count'], 'last': s['last']})
        return courses, rows

    def save(self, p):
        st = self.find(p)
        if not st:
            return {'ok': False, 'error': NOT_FOUND}
        course = str(p.get('course') or '').strip()[:40]
        try:
            sec = round(float(p.get('sec')), 2)
        except (TypeError, ValueError):
            sec = 0
        if not course or not 0 < sec <= 3600:
            return {'ok': False, 'error': '기록 값이 올바르지 않아요.'}
        try:
            target = float(p.get('target'))
            target = target if target > 0 else ''
        except (TypeError, ValueError):
            target = ''
        laps = p.get('laps') if isinstance(p.get('laps'), list) else []
        laps = ', '.join(f'{float(x):.2f}' for x in laps[:20] if isinstance(x, (int, float)) and x > 0)
        rid = str(p.get('id') or '')[:64] or uuid.uuid4().hex
        if rid in self.ids:
            return {'ok': True, 'duplicate': True, 'records': self.summary(st)}

        now = dt.datetime.now()
        try:                                  # 측정한 시각 (오프라인으로 늦게 도착해도 실제 시각)
            when = dt.datetime.fromtimestamp(float(p.get('at')) / 1000)
        except Exception:
            when = now
        if when > now or (now - when).days > 30:
            when = now

        rec = {'id': rid, 'at': when.isoformat(timespec='seconds'), 'name': st['name'], 'birth': st['birth'],
               'grade': st['grade'], 'cls': st['cls'], 'num': st['num'], 'course': course, 'sec': sec,
               'target': target, 'result': {'ok': '성공', 'fail': '실패'}.get(p.get('result'), ''), 'laps': laps}
        with open(self.journal_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
            f.flush()
            os.fsync(f.fileno())
        self.records.append(rec)
        self.ids.add(rid)
        self.version += 1
        self.wake.set()
        return {'ok': True, 'records': self.summary(st)}

    def set_excluded(self, rid, on):
        self._read_marks()
        if rid not in self.ids:
            return {'ok': False, 'error': '없는 기록이에요.'}
        (self.excluded.add if on else self.excluded.discard)(rid)
        self._save_excluded()
        self.version += 1
        self.wake.set()
        return self.board()

    # ---------- 러닝기록.xlsx ----------
    def _read_marks(self):
        """선생님이 엑셀에서 '제외' 열에 표시하고 저장했으면 반영"""
        try:
            m = self.book_path.stat().st_mtime
        except OSError:
            return
        if m == self.book_mtime:
            return
        try:
            wb = openpyxl.load_workbook(self.book_path, read_only=True, data_only=True)
            try:
                rows = list(wb['기록'].iter_rows(values_only=True)) if '기록' in wb.sheetnames else []
            finally:
                wb.close()
        except Exception:
            return                            # 엑셀이 쓰는 중: 다음에 다시
        self.book_mtime = m
        if not rows:
            return
        h = [cell(x) for x in rows[0]]
        if '기록ID' not in h or '제외' not in h:
            return
        iid, iex = h.index('기록ID'), h.index('제외')
        seen, marked = set(), set()
        for r in rows[1:]:
            rid = cell(r[iid]) if iid < len(r) else ''
            if not rid:
                continue
            seen.add(rid)
            if iex < len(r) and cell(r[iex]):
                marked.add(rid)
        new = (self.excluded - seen) | marked
        if new != self.excluded:
            self.excluded = new
            self._save_excluded()
            self.version += 1

    def write_book(self):
        with self.lock:
            self._read_marks()
            version = self.version
            courses, best = self.best_table()
            recs, excluded = list(self.records), set(self.excluded)

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = '최고기록'
        head = ['학년', '반', '번호', '이름'] + [c + ' 최고(초)' for c in courses] + ['측정 횟수', '최근 측정']
        ws.append(head)
        for b in best:
            last = dt.datetime.fromisoformat(b['last']) if b['last'] else ''
            ws.append([as_num(b['grade']), as_num(b['cls']), as_num(b['num']), b['name']]
                      + [b['best'].get(c, '') for c in courses] + [b['count'], last])
        for row in ws.iter_rows(min_row=2, min_col=5, max_col=4 + len(courses)):
            for c in row:
                c.number_format = '0.00'
        for row in ws.iter_rows(min_row=2, min_col=len(head), max_col=len(head)):
            for c in row:
                c.number_format = 'yyyy-mm-dd hh:mm'
        style_head(ws, len(head))
        ws.column_dimensions['D'].width = 12
        for i in range(5, len(head) + 1):
            ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = 16

        ws2 = wb.create_sheet('기록')
        ws2.append(RECORD_HEADERS)
        for r in recs:
            ws2.append([dt.datetime.fromisoformat(r['at']), as_num(r['grade']), as_num(r['cls']), as_num(r['num']),
                        r['name'], r['course'], r['sec'], r['target'], r['result'], r['laps'],
                        'O' if r['id'] in excluded else '', r['id']])
        for row in ws2.iter_rows(min_row=2):
            row[0].number_format = 'yyyy-mm-dd hh:mm:ss'
            row[6].number_format = row[7].number_format = '0.00'
        style_head(ws2, len(RECORD_HEADERS))
        for col, w in zip('ABCDEFGHIJKL', (20, 6, 6, 6, 12, 12, 10, 10, 8, 18, 6, 38)):
            ws2.column_dimensions[col].width = w

        tmp = self.book_path.with_name('.저장중-' + BOOK_FILE)
        try:
            wb.save(tmp)
            os.replace(tmp, self.book_path)
        except OSError as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            with self.lock:
                self.book_error = LOCKED if isinstance(e, PermissionError) else f'엑셀 저장 오류: {e}'
            return False
        with self.lock:
            self.book_mtime = self.book_path.stat().st_mtime
            self.written_version = max(self.written_version, version)
            self.book_error = ''
            self.saved_at = dt.datetime.now().strftime('%H:%M:%S')
        return True

    def writer(self):
        """여러 기기의 저장을 모아 엑셀에 쓰고, 엑셀이 열려 있으면 닫힐 때까지 다시 시도"""
        while True:
            self.wake.wait(5)
            self.wake.clear()
            time.sleep(0.6)
            try:
                with self.lock:
                    self._read_marks()
                    need = self.version != self.written_version
                if need:
                    self.write_book()
            except Exception as e:
                traceback.print_exc()
                with self.lock:
                    self.book_error = f'엑셀 저장 오류: {e}'

    # ---------- 선생님 화면 ----------
    def board(self):
        courses, best = self.best_table()
        recent = [{'id': r['id'], 'at': short_time(r['at']), 'who': label(r), 'name': r['name'],
                   'course': r['course'], 'sec': r['sec'], 'result': r['result'], 'excluded': r['id'] in self.excluded}
                  for r in reversed(self.records[-60:])]
        try:
            self.roster()
            roster_error = ''
        except RosterError as e:
            roster_error = str(e)
        return {'ok': True, 'courses': courses, 'best': best, 'recent': recent, 'total': len(self.active()),
                'pending': self.version != self.written_version, 'bookError': self.book_error,
                'rosterError': roster_error, 'savedAt': self.saved_at,
                'files': {'roster': str(self.roster_path), 'book': str(self.book_path), 'dir': str(self.dir)},
                'addresses': ADDRESSES}

    def open_path(self, which):
        path = {'roster': self.roster_path, 'book': self.book_path, 'dir': self.dir}.get(which)
        if not path:
            return {'ok': False, 'error': '알 수 없는 파일이에요.'}
        if which == 'book' and not path.exists():
            self.write_book()
        try:
            if sys.platform.startswith('win'):
                os.startfile(str(path))
            elif sys.platform == 'darwin':
                subprocess.Popen(['open', str(path)])
            else:
                subprocess.Popen(['xdg-open', str(path)])
        except OSError as e:
            return {'ok': False, 'error': f'열 수 없어요: {e}'}
        return {'ok': True}

    def route(self, p, local):
        action = p.get('action')
        with self.lock:
            try:
                if action == 'login':
                    st = self.find(p)
                    if not st:
                        return {'ok': False, 'error': NOT_FOUND}
                    return {'ok': True, 'student': {'name': st['name'], 'label': label(st)}, 'records': self.summary(st)}
                if action == 'records':
                    st = self.find(p)
                    return {'ok': True, 'records': self.summary(st)} if st else {'ok': False, 'error': NOT_FOUND}
                if action == 'save':
                    return self.save(p)
                if action in ('board', 'exclude', 'open'):
                    if not local:
                        return {'ok': False, 'error': '선생님 컴퓨터에서만 쓸 수 있어요.'}
                    if action == 'board':
                        return self.board()
                    if action == 'exclude':
                        return self.set_excluded(str(p.get('id') or ''), bool(p.get('on')))
                    return self.open_path(p.get('which'))
                if not action or action == 'ping':
                    return {'ok': True, 'app': 'running-timer', 'mode': 'local'}
                return {'ok': False, 'error': '알 수 없는 요청입니다.'}
            except RosterError as e:
                return {'ok': False, 'error': str(e)}
            except Exception as e:
                traceback.print_exc()
                return {'ok': False, 'error': f'서버 오류: {e}'}


# ================= 웹 서버 =================

TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
         '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mp4': 'video/mp4',
         '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'}
BLOCKED_TOP = {'server', 'apps-script'}
STORE = None
ADDRESSES = []


class Handler(BaseHTTPRequestHandler):
    server_version = 'RunningTimer/1.0'

    def log_message(self, fmt, *args):
        pass

    def is_local(self):
        return self.client_address[0] in ('127.0.0.1', '::1', '::ffff:127.0.0.1')

    def do_HEAD(self):
        self.handle_get(True)

    def do_GET(self):
        self.handle_get(False)

    def do_POST(self):
        if urlparse(self.path).path != '/api':
            return self.send_error(404)
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        if n > 100_000:
            return self.send_error(413)
        try:
            p = json.loads(self.rfile.read(n).decode('utf-8') or '{}')
        except (ValueError, UnicodeDecodeError):
            p = {}
        if not isinstance(p, dict):
            p = {}
        self.send_body(json.dumps(STORE.route(p, self.is_local()), ensure_ascii=False).encode('utf-8'),
                       'application/json; charset=utf-8', False, 'no-store')

    def handle_get(self, head):
        path = unquote(urlparse(self.path).path)
        if path == '/sheet-config.js':       # 이 서버로 접속하면 저장 위치는 항상 이 컴퓨터
            return self.send_body(b"window.RUNNING_SHEET_URL = '/api';\n", TYPES['.js'], head, 'no-store')
        if path == '/api':
            return self.send_body(b'{"ok":true,"app":"running-timer","mode":"local"}', TYPES['.json'], head, 'no-store')
        if path in ('', '/'):
            path = '/index.html'
        target = (APP_DIR / path.lstrip('/')).resolve()
        try:
            rel = target.relative_to(APP_DIR)
        except ValueError:
            return self.send_error(404)
        if (any(part.startswith('.') for part in rel.parts) or (rel.parts and rel.parts[0] in BLOCKED_TOP)
                or target == STORE.dir or STORE.dir in target.parents):
            return self.send_error(404)       # 학생 기록 · 서버 코드 · .git 은 내보내지 않음
        if target.is_dir():
            target = target / 'index.html'
        if not target.is_file():
            return self.send_error(404)
        self.send_file(target, head)

    def send_body(self, body, ctype, head, cache='no-cache'):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def send_file(self, path, head):
        """동영상은 Range 요청(부분 전송)을 지원해야 아이폰·아이패드에서 재생된다"""
        size = path.stat().st_size
        ctype = TYPES.get(path.suffix.lower(), 'application/octet-stream')
        start, end, status = 0, size - 1, 200
        m = re.fullmatch(r'bytes=(\d*)-(\d*)', (self.headers.get('Range') or '').strip())
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Cache-Control', 'no-cache' if ctype.startswith('text/') else 'max-age=3600')
        self.end_headers()
        if head:
            return
        try:
            with open(path, 'rb') as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = not sys.platform.startswith('win')   # 윈도우에선 이미 쓰는 포트에 겹쳐 열리지 않게


def lan_addresses():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))       # 실제로 보내지는 않음: 기본 네트워크의 내 IP 확인용
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        ips += socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    out = []
    for ip in ips:
        if not ip.startswith('127.') and ip not in out:
            out.append(ip)
    return out


def main():
    global STORE, ADDRESSES
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except Exception:
            pass

    ap = argparse.ArgumentParser(description='러닝 타이머 로컬 서버')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--data', default=str(APP_DIR / '기록'), help='학생명단·기록 엑셀 파일을 둘 폴더')
    ap.add_argument('--no-browser', action='store_true', help='시작할 때 선생님 화면을 열지 않음')
    args = ap.parse_args()

    STORE = Store(args.data)
    httpd = None
    for port in range(args.port, args.port + 20):
        try:
            httpd = Server(('0.0.0.0', port), Handler)
            break
        except OSError:
            continue
    if not httpd:
        sys.exit(f'{args.port}~{args.port + 19}번 포트를 열 수 없어요. 다른 프로그램을 닫고 다시 실행하세요.')
    port = httpd.server_address[1]
    ADDRESSES = [f'http://{ip}:{port}' for ip in lan_addresses()]

    threading.Thread(target=STORE.writer, daemon=True).start()
    STORE.wake.set()

    line = '=' * 60
    print(line)
    print(' 러닝 타이머 로컬 서버가 켜졌어요')
    print('-' * 60)
    print(' 학생 기기(같은 와이파이)에서 접속할 주소:')
    for a in ADDRESSES or ['(네트워크 연결을 확인하세요)']:
        print('    ' + a)
    print(f' 이 컴퓨터에서:      http://localhost:{port}')
    print(f' 선생님 관리 화면:   http://localhost:{port}/teacher.html')
    print(f' 학생명단:  {STORE.roster_path}')
    print(f' 기록 파일: {STORE.book_path}')
    print(' 끄려면 이 창을 닫거나 Ctrl+C')
    print(line, flush=True)

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f'http://localhost:{port}/teacher.html')).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n서버를 종료합니다. 기록은 저장되어 있어요.')
    finally:
        try:
            STORE.write_book()
        except Exception:
            pass


if __name__ == '__main__':
    main()
