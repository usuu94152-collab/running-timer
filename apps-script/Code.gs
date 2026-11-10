/**
 * 러닝 타이머 ↔ 구글 시트 연결 (Apps Script 웹 앱)
 *
 * 이 파일 전체를 구글 시트의 [확장 프로그램 → Apps Script] 에 붙여 넣고
 * 웹 앱으로 배포하세요. 자세한 순서는 저장소의 SHEET-SETUP.md 참고.
 *
 * 시트 구성
 *   학생명단 : 교사가 입력. 첫 줄에 "이름", "생년월일" 열이 꼭 있어야 함
 *             ("학년", "반", "번호" 열은 있으면 함께 사용)
 *   기록     : 측정할 때마다 한 줄씩 자동 추가
 *   최고기록 : 학생 × 코스별 최고 기록, 저장할 때마다 자동으로 다시 계산
 */

const ROSTER_SHEET = '학생명단';
const RECORD_SHEET = '기록';
const BEST_SHEET   = '최고기록';
const COURSES = ['301번 버스', '지그재그', '이어달리기', '장애물'];
const RECORD_HEADERS = ['측정일시', '학년', '반', '번호', '이름', '생년월일', '코스', '기록(초)', '목표(초)', '결과', '랩(초)', '기록ID'];

/* ================= 웹 앱 진입점 ================= */

function doGet(e)  { return reply_(route_((e && e.parameter) || {})); }

function doPost(e) {
  let p = {};
  try { p = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (_) { p = (e && e.parameter) || {}; }
  return reply_(route_(p));
}

function route_(p) {
  try {
    if (p.action === 'login')   return login_(p);
    if (p.action === 'save')    return save_(p);
    if (p.action === 'records') return records_(p);
    if (!p.action || p.action === 'ping') return { ok: true, app: 'running-timer' };
    return { ok: false, error: '알 수 없는 요청입니다.' };
  } catch (err) {
    return { ok: false, error: '시트 처리 중 오류: ' + ((err && err.message) || err) };
  }
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= 요청 처리 ================= */

const NOT_FOUND = '학생명단에서 찾을 수 없어요. 이름과 생년월일을 다시 확인해 주세요.';

function login_(p) {
  const st = findStudent_(p);
  if (!st) return { ok: false, error: NOT_FOUND };
  return { ok: true, student: { name: st.name, label: label_(st) }, records: summary_(st) };
}

function records_(p) {
  const st = findStudent_(p);
  if (!st) return { ok: false, error: NOT_FOUND };
  return { ok: true, records: summary_(st) };
}

function save_(p) {
  const st = findStudent_(p);
  if (!st) return { ok: false, error: NOT_FOUND };

  const course = String(p.course || '').trim().slice(0, 40);
  const sec = Math.round(Number(p.sec) * 100) / 100;
  if (!course || !isFinite(sec) || sec <= 0 || sec > 3600) return { ok: false, error: '기록 값이 올바르지 않아요.' };

  const target = Number(p.target) > 0 ? Number(p.target) : '';
  const result = p.result === 'ok' ? '성공' : p.result === 'fail' ? '실패' : '';
  const laps = Array.isArray(p.laps)
    ? p.laps.map(Number).filter(n => isFinite(n) && n > 0).slice(0, 20).map(n => n.toFixed(2)).join(', ')
    : '';
  const id = String(p.id || '').slice(0, 64);

  // 측정한 시각(오프라인으로 늦게 저장되어도 실제 측정 시각을 남김)
  let when = new Date(Number(p.at));
  const now = new Date();
  if (isNaN(when.getTime()) || when > now || now - when > 30 * 864e5) when = now;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = recordSheet_();
    if (id && isDuplicate_(sh, id)) return { ok: true, duplicate: true, records: summary_(st) };
    sh.appendRow([when, st.grade, st.cls, st.num, st.name, st.birth, course, sec, target, result, laps, id]);
    sh.getRange(sh.getLastRow(), 8).setNumberFormat('0.00');
    rebuildBest_();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, records: summary_(st) };
}

/* ================= 학생명단 ================= */

function roster_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(ROSTER_SHEET);
  if (!sh) sh = ss.getSheets().filter(s => [RECORD_SHEET, BEST_SHEET].indexOf(s.getName()) < 0)[0];
  if (!sh) throw new Error('"학생명단" 시트가 없습니다.');

  const values = sh.getDataRange().getValues();
  // 머리글 줄: 위에서 10줄 안에 "이름"과 "생년월일"이 함께 있는 첫 줄
  for (let r = 0; r < Math.min(10, values.length); r++) {
    const c = headerCols_(values[r]);
    if (c.name < 0 || c.birth < 0) continue;
    const list = [];
    for (let i = r + 1; i < values.length; i++) {
      const row = values[i];
      const name = normName_(row[c.name]);
      const birth = birthKey_(row[c.birth]);
      if (!name || !birth) continue;
      list.push({ name: name, birth: birth, grade: cell_(row, c.grade), cls: cell_(row, c.cls), num: cell_(row, c.num) });
    }
    return list;
  }
  throw new Error('"학생명단" 시트 첫 줄에 "이름"과 "생년월일" 열이 필요합니다.');
}

function headerCols_(row) {
  const c = { name: -1, birth: -1, grade: -1, cls: -1, num: -1 };
  row.forEach((v, i) => {
    const h = String(v).replace(/\s/g, '');
    if (c.name < 0 && /^(이름|성명|학생명|학생이름)$/.test(h)) c.name = i;
    else if (c.birth < 0 && /생년월일|생일/.test(h)) c.birth = i;
    else if (c.grade < 0 && h === '학년') c.grade = i;
    else if (c.cls < 0 && h === '반') c.cls = i;
    else if (c.num < 0 && /^(번호|번)$/.test(h)) c.num = i;
  });
  return c;
}

function findStudent_(p) {
  const name = normName_(p.name);
  const birth = birthKey_(p.birth);
  if (!name || !birth) return null;
  return roster_().filter(s => s.name === name && s.birth === birth)[0] || null;
}

function label_(st) {
  return [st.grade && st.grade + '학년', st.cls && st.cls + '반', st.num && st.num + '번'].filter(Boolean).join(' ');
}

/* ================= 기록 ================= */

function recordSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(RECORD_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RECORD_SHEET);
    sh.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS])
      .setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange('F:F').setNumberFormat('@');        // 생년월일 앞자리 0 보존
    sh.getRange('H:I').setNumberFormat('0.00');
  }
  return sh;
}

function isDuplicate_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return false;
  const col = RECORD_HEADERS.indexOf('기록ID') + 1;
  const from = Math.max(2, last - 1000);
  return sh.getRange(from, col, last - from + 1, 1).getValues().some(r => r[0] === id);
}

function recordRows_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(RECORD_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues();
  const h = v[0].map(x => String(x).trim());
  const I = {
    at: h.indexOf('측정일시'), name: h.indexOf('이름'), birth: h.indexOf('생년월일'), course: h.indexOf('코스'),
    sec: h.indexOf('기록(초)'), target: h.indexOf('목표(초)'), result: h.indexOf('결과')
  };
  return v.slice(1).map(r => ({
    at: r[I.at] instanceof Date ? r[I.at] : null,
    name: normName_(r[I.name]),
    birth: birthKey_(r[I.birth]),
    course: String(r[I.course] || '').trim(),
    sec: Number(r[I.sec]) || 0,
    target: Number(r[I.target]) || 0,
    result: String(r[I.result] || '')
  })).filter(r => r.name && r.course && r.sec > 0);
}

// 한 학생의 기록 요약: 코스별 최고 기록 + 최근 10회
function summary_(st) {
  const tz = tz_();
  const mine = recordRows_().filter(r => r.name === st.name && r.birth === st.birth);
  const best = {};
  mine.forEach(r => {
    const b = best[r.course];
    if (!b || r.sec < b.sec) best[r.course] = { sec: r.sec, result: r.result, target: r.target };
  });
  const recent = mine.slice(-10).reverse().map(r => ({
    at: r.at ? Utilities.formatDate(r.at, tz, 'M/d HH:mm') : '',
    course: r.course, sec: r.sec, result: r.result
  }));
  return { count: mine.length, best: best, recent: recent };
}

/* ================= 최고기록 (교사용 한눈에 보기) ================= */

function rebuildBest_() {
  const ss = SpreadsheetApp.getActive();
  const roster = roster_();
  const rows = recordRows_();

  const courses = COURSES.slice();
  rows.forEach(r => { if (courses.indexOf(r.course) < 0) courses.push(r.course); });

  const stats = {};
  rows.forEach(r => {
    const k = r.name + '|' + r.birth;
    const s = stats[k] || (stats[k] = { best: {}, count: 0, last: null });
    s.count++;
    if (r.at && (!s.last || r.at > s.last)) s.last = r.at;
    if (!(r.course in s.best) || r.sec < s.best[r.course]) s.best[r.course] = r.sec;
  });

  const header = ['학년', '반', '번호', '이름']
    .concat(courses.map(c => c + ' 최고(초)'), ['측정 횟수', '최근 측정']);
  const out = [header];
  roster.forEach(st => {
    const s = stats[st.name + '|' + st.birth] || { best: {}, count: 0, last: null };
    out.push([st.grade, st.cls, st.num, st.name]
      .concat(courses.map(c => (c in s.best ? s.best[c] : '')), [s.count, s.last || '']));
  });

  const sh = ss.getSheetByName(BEST_SHEET) || ss.insertSheet(BEST_SHEET);
  sh.clear();
  sh.getRange(1, 1, out.length, header.length).setValues(out);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#e8f0fe');
  sh.setFrozenRows(1);
  if (out.length > 1) {
    sh.getRange(2, 5, out.length - 1, courses.length).setNumberFormat('0.00');
    sh.getRange(2, header.length, out.length - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
}

/* ================= 시트 메뉴 ================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('러닝 타이머')
    .addItem('시트 준비하기 (처음 한 번)', 'setup')
    .addItem('최고기록 다시 계산', 'rebuildBest')
    .addToUi();
}

// 학생명단 / 기록 / 최고기록 시트를 만들어 둔다 (이미 있으면 그대로 둠)
function setup() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(ROSTER_SHEET);
  if (!sh) {
    const first = ss.getSheets()[0];
    sh = first.getLastRow() === 0 ? first.setName(ROSTER_SHEET) : ss.insertSheet(ROSTER_SHEET, 0);
  }
  if (sh.getLastRow() === 0) {
    sh.getRange('E:E').setNumberFormat('@');          // 생년월일 앞자리 0 보존
    sh.getRange(1, 1, 2, 5).setValues([
      ['학년', '반', '번호', '이름', '생년월일'],
      [3, 1, 1, '홍길동', '120305']
    ]);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
  }
  recordSheet_();
  rebuildBest_();
  ss.toast('학생명단에 학생을 입력한 뒤 웹 앱으로 배포하세요.', '러닝 타이머 준비 완료', 8);
}

function rebuildBest() {
  rebuildBest_();
  SpreadsheetApp.getActive().toast('최고기록을 다시 계산했습니다.', '러닝 타이머', 5);
}

/* ================= 도우미 ================= */

function tz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || Session.getScriptTimeZone(); }
function normName_(v) { return String(v == null ? '' : v).replace(/\s/g, ''); }
function cell_(row, i) { return i >= 0 && row[i] !== '' && row[i] != null ? String(row[i]).trim() : ''; }
function pad2_(x) { return ('0' + x).slice(-2); }

// 생년월일 → YYMMDD 6자리. "120305", "20120305", "2012-03-05", "2012.3.5", 날짜 셀 모두 같은 값이 됨
function birthKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyMMdd');
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const parts = s.split(/\D+/).filter(Boolean);
  if (parts.length === 3) return pad2_(parts[0].slice(-2)) + pad2_(parts[1]) + pad2_(parts[2]);
  let d = s.replace(/\D/g, '');
  if (d.length === 8) d = d.slice(2);
  if (d.length === 5) d = '0' + d;                   // 숫자 셀에서 앞자리 0이 빠진 경우
  return d.length === 6 ? d : '';
}
