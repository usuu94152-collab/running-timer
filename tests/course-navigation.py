"""Run with python3 tests/course-navigation.py (requires Playwright and Chromium).

Serves real pages/videos locally; mocks the Sheets API so no live student records
are read or written. Verifies obstacle-only navigation, direct URL redirects and stale preferences.
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
                result = {'ok': True, 'course': '지그재그', 'recording': True, 'classKey': '2-1', 'since': 1}
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
          localStorage.setItem('running-timer-course', JSON.stringify('지그재그'));
        }""")
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        clips = set()
        for viewport in [{'width': 1280, 'height': 900}, {'width': 390, 'height': 844}]:
            page.set_viewport_size(viewport)
            page.goto(base + '/bread.html')
            for path, name in COURSES:
                page.goto(base + '/' + path)
                expect(page).to_have_url(base + '/bread.html')
                expect(page.locator('#recBadge')).to_contain_text('2학년 1반 기록 중')
                expect(page.locator('.nav a[aria-current]')).to_have_text('장애물')
                for course_path, _ in COURSES:
                    link = page.locator(f'.nav a[href="{course_path}"]')
                    if course_path == 'bread.html':
                        expect(link).to_be_visible()
                    else:
                        expect(link).to_be_hidden()
                expect(page.locator('#mineBest .mine__tile')).to_have_count(1)
                expect(page.locator('#mineBest')).to_contain_text('장애물')
                page.wait_for_function("[...document.querySelectorAll('video')].every(v => v.readyState >= 1)")
                clips.add(page.locator('#clip').get_attribute('src'))
                page.locator('#toggle').click()
                page.wait_for_timeout(150)
                page.locator('#lap').click()
                page.locator('#toggle').click()
                expect(page.locator('#saveText')).to_contain_text('저장됨')
                assert saves[-1]['course'] == '장애물'
                assert saves[-1]['sec'] > 0 and len(saves[-1]['laps']) == 1
                expect(page).to_have_url(base + '/bread.html')
                page.locator('#reset').click()
                expect(page.locator('#ss')).to_have_text('00')
            page.reload()
            expect(page.locator('#mineBest .mine__tile')).to_have_count(1)
        assert clips == {'BREAD-RUN-INTRO.mp4'}
        assert len(saves) == 8
        anonymous = browser.new_context(reduced_motion='reduce')
        anonymous.route('**/sheet-config.js', lambda route: route.fulfill(
            body="window.RUNNING_SHEET_URL = '/api';", content_type='application/javascript'))
        anonymous.route('**/api', api)
        guest = anonymous.new_page()
        guest.goto(base + '/index.html')
        expect(guest).to_have_url(base + '/bread.html')
        expect(guest.locator('#gateForm')).to_be_visible()
        expect(guest.locator('.nav a[href="index.html"]')).to_be_hidden()
        expect(guest.locator('.nav a[href="bread.html"]')).to_be_visible()
        anonymous.close()
        assert not errors, errors
        browser.close()
    print('PASS: obstacle-only tabs and best record, direct URL redirects, stale preference/status, timer/lap/save/reset, anonymous login, desktop/mobile')
finally:
    server.shutdown()
    server.server_close()
    thread.join()
