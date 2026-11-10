"""Run with python3 tests/course-navigation.py (requires Playwright and Chromium).

Serves real pages/videos locally; mocks the Sheets API so no live student records
are read or written. Includes an old cached obstacle-only preference.
"""
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
COURSES = [('index.html', '301번 버스'), ('zigzag.html', '지그재그'),
           ('relay.html', '이어달리기'), ('bread.html', '장애물')]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(reduced_motion='reduce')
        saves, errors = [], []
        summary = {'count': 4, 'best': {name: {'sec': 6 + i, 'result': '성공'} for i, (_, name) in enumerate(COURSES)},
                   'recent': [], 'practice': {'course': '장애물', 'open': True, 'count': 1, 'topN': 3, 'sum': None}}
        student = {'name': '테스트학생', 'label': '2학년 1반 1번', 'classKey': '2-1'}

        def api(route):
            body = route.request.post_data_json
            if body['action'] == 'status':
                result = {'ok': True, 'course': '장애물', 'recording': True, 'classKey': '2-1', 'since': 1}
            else:
                if body['action'] == 'save':
                    saves.append(body)
                result = {'ok': True, 'student': student, 'records': summary}
            route.fulfill(json=result)

        context.route('**/sheet-config.js', lambda route: route.fulfill(
            body="window.RUNNING_SHEET_URL = '/api';", content_type='application/javascript'))
        context.route('**/api', api)
        context.add_init_script("""if (!localStorage.getItem('running-timer-device')) {
          localStorage.setItem('running-timer-device', JSON.stringify({
            students: [{name:'테스트학생', label:'2학년 1반 1번', classKey:'2-1', token:'test'}], active:'test'
          }));
          localStorage.setItem('running-timer-course', JSON.stringify('장애물'));
        }""")
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        clips = set()
        for viewport in [{'width': 1280, 'height': 900}, {'width': 390, 'height': 844}]:
            page.set_viewport_size(viewport)
            page.goto(base + '/bread.html')
            for path, name in COURSES:
                page.locator(f'.nav a[href="{path}"]').click()
                expect(page).to_have_url(base + '/' + path)
                expect(page.locator('#recBadge')).to_contain_text('2학년 1반 기록 중')
                expect(page.locator('.nav a[aria-current]')).to_have_text(name)
                for course_path, _ in COURSES:
                    expect(page.locator(f'.nav a[href="{course_path}"]')).to_be_visible()
                expect(page.locator('#mineBest .mine__tile')).to_have_count(4)
                expect(page.locator('#mineBest')).to_contain_text('장애물')
                page.wait_for_function("[...document.querySelectorAll('video')].every(v => v.readyState >= 1)")
                clips.add(page.locator('#clip').get_attribute('src'))
                page.locator('#toggle').click()
                page.wait_for_timeout(150)
                page.locator('#lap').click()
                page.locator('#toggle').click()
                expect(page.locator('#saveText')).to_contain_text('저장됨')
                assert saves[-1]['course'] == name
                assert saves[-1]['sec'] > 0 and len(saves[-1]['laps']) == 1
                expect(page).to_have_url(base + '/' + path)
                page.locator('#reset').click()
                expect(page.locator('#ss')).to_have_text('00')
                if name != '장애물':
                    expect(page.locator('#crewToday')).to_be_hidden()
            page.reload()
            expect(page.locator('#mineBest .mine__tile')).to_have_count(4)
        assert len(clips) == 4
        assert len(saves) == 8
        assert not errors, errors
        browser.close()
    print('PASS: all 4 tabs, distinct existing videos, timers/laps/save/reset, cached preference, obstacle assessment, desktop/mobile')
finally:
    server.shutdown()
    server.server_close()
    thread.join()
