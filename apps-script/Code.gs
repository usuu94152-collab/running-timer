/**
 * 러닝 타이머 ↔ 구글 시트 연결 (Apps Script 웹 앱)
 *
 * 이 파일 전체를 구글 시트의 [확장 프로그램 → Apps Script] 에 붙여 넣고
 * 웹 앱으로 배포하세요. 자세한 순서는 저장소의 SHEET-SETUP.md 참고.
 *
 * 로그인
 *   처음: 이름 + 담임 선생님 성함(임시 비밀번호) → 바로 내 비밀번호를 만든다
 *   이후: 이름 + 내 비밀번호 (담임 성함으로는 더 이상 로그인되지 않음)
 *   잊어버리면: 학생명단의 "비밀번호(자동)" 칸을 지우면 처음 상태로 돌아간다
 *
 * 기록 시간
 *   선생님 페이지(teacher.html)나 시트 메뉴에서 [기록 시작]을 누른 동안만 기록이 저장된다
 *   선생님 페이지 비밀번호는 시트 메뉴 [러닝 타이머 → 선생님 비밀번호 정하기]에서 정한다
 *
 * 시트 구성
 *   학생명단 : 교사가 입력. 첫 줄에 "이름", "담임" 열 ("학년", "반", "번호"는 있으면 사용)
 *             "비밀번호(자동)" 열은 학생이 비밀번호를 만들면 암호화된 값이 자동으로 채워짐
 *   기록     : 측정할 때마다 한 줄씩 자동 추가
 *   최고기록 : 학생 × 코스별 최고 기록, 저장할 때마다 자동으로 다시 계산
 */

const ROSTER_SHEET = '학생명단';
const RECORD_SHEET = '기록';
const BEST_SHEET   = '최고기록';
const PASS_HEADER  = '비밀번호(자동)';
const COURSES = ['301번 버스', '지그재그', '이어달리기', '장애물'];
const RECORD_HEADERS = ['측정일시', '학년', '반', '번호', '이름', '코스', '기록(초)', '목표(초)', '결과', '랩(초)', '기록ID', '제외'];

const MSG_BAD     = '이름 또는 비밀번호가 맞지 않아요.';
const MSG_RELOGIN = '다시 로그인해 주세요.';
const MSG_SAME    = '같은 이름의 학생이 있어 구분할 수 없어요. 선생님께 말해 주세요.';
const MSG_LOCKED  = '비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도하거나 선생님께 말해 주세요.';
const MAX_FAILS = 10;

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
    if (p.action === 'login')       return login_(p);
    if (p.action === 'setPassword') return setPassword_(p);
    if (p.action === 'save')        return save_(p);
    if (p.action === 'records')     return records_(p);
    if (p.action === 'status')      return Object.assign({ ok: true }, statusOut_());
    if (p.action === 'teacherLogin') return teacherLogin_(p);
    if (p.action === 'teacher')     return teacher_(p);
    if (!p.action || p.action === 'ping') return { ok: true, app: 'running-timer' };
    return { ok: false, error: '알 수 없는 요청입니다.' };
  } catch (err) {
    return { ok: false, error: '시트 처리 중 오류: ' + ((err && err.message) || err) };
  }
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= 로그인 · 비밀번호 ================= */

// 이름 + 비밀번호에 맞는 학생 찾기. own: 내 비밀번호로 맞음, temp: 아직 비밀번호가 없고 담임 성함으로 맞음
function match_(list, name, pw) {
  const same = list.filter(s => s.name === name);
  const own = same.filter(s => s.hash && checkHash_(pw, s.hash));
  const temp = same.filter(s => !s.hash && s.homeroom && normTeacher_(pw) === normTeacher_(s.homeroom));
  return { same: same, own: own, temp: temp };
}

function login_(p) {
  const name = normName_(p.name), pw = String(p.password || '').trim();
  if (!name || !pw) return { ok: false, error: MSG_BAD };
  if (fails_(name) >= MAX_FAILS) return { ok: false, error: MSG_LOCKED };

  const m = match_(roster_().list, name, pw);
  if (m.own.length + m.temp.length > 1) return { ok: false, error: MSG_SAME };
  if (m.own.length === 1) {
    clearFails_(name);
    const s = m.own[0];
    return { ok: true, student: info_(s), token: token_(s), records: summary_(s) };
  }
  if (m.temp.length === 1) {
    clearFails_(name);
    return { ok: true, mustChange: true, student: info_(m.temp[0]) };
  }
  addFail_(name);
  if (m.same.length && m.same.every(s => !s.hash && !s.homeroom)) {
    return { ok: false, error: '학생명단에 담임 선생님 성함이 비어 있어요. 선생님께 말해 주세요.' };
  }
  return { ok: false, error: MSG_BAD };
}

// 첫 로그인(담임 성함) 또는 내 비밀번호로 확인한 뒤 새 비밀번호 저장
function setPassword_(p) {
  const name = normName_(p.name), pw = String(p.password || '').trim(), next = String(p.newPassword || '').trim();
  if (!name || !pw) return { ok: false, error: MSG_BAD };
  if (next.length < 4 || next.length > 20) return { ok: false, error: '새 비밀번호는 4~20자로 만들어 주세요.' };
  if (fails_(name) >= MAX_FAILS) return { ok: false, error: MSG_LOCKED };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const r = roster_();
    const m = match_(r.list, name, pw);
    if (m.own.length + m.temp.length > 1) return { ok: false, error: MSG_SAME };
    const s = m.own[0] || m.temp[0];
    if (!s) { addFail_(name); return { ok: false, error: MSG_BAD }; }
    if (s.homeroom && normTeacher_(next) === normTeacher_(s.homeroom)) {
      return { ok: false, error: '담임 선생님 성함이 아닌 나만 아는 비밀번호로 만들어 주세요.' };
    }
    // 이름이 같은 다른 반 학생과 비밀번호까지 같으면 로그인 때 구분할 수 없음
    if (m.same.some(x => x !== s && ((x.hash && checkHash_(next, x.hash)) ||
                                     (!x.hash && x.homeroom && normTeacher_(next) === normTeacher_(x.homeroom))))) {
      return { ok: false, error: '이 비밀번호는 쓸 수 없어요. 다른 비밀번호로 만들어 주세요.' };
    }
    s.hash = makeHash_(next);
    r.sheet.getRange(s.row, passCol_(r)).setValue(s.hash);
    clearFails_(name);
    return { ok: true, student: info_(s), token: token_(s), records: summary_(s) };
  } finally {
    lock.releaseLock();
  }
}

/* ================= 기록 ================= */

function records_(p) {
  const s = fromToken_(p.token);
  if (!s) return { ok: false, relogin: true, error: MSG_RELOGIN };
  return { ok: true, records: summary_(s) };
}

function save_(p) {
  const s = fromToken_(p.token);
  if (!s) return { ok: false, relogin: true, error: MSG_RELOGIN };

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
  if (!inSession_(when.getTime())) {
    return { ok: false, closed: true, error: '기록 시간이 아니라 저장하지 않았어요. 선생님이 [기록 시작]을 누르면 저장돼요.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = recordSheet_();
    if (id && isDuplicate_(sh, id)) return { ok: true, duplicate: true, records: summary_(s) };
    sh.appendRow([when, s.grade, s.cls, s.num, s.name, course, sec, target, result, laps, id]);
    sh.getRange(sh.getLastRow(), 7).setNumberFormat('0.00');
    rebuildBest_();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, records: summary_(s) };
}

/* ================= 학생명단 ================= */

function roster_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(ROSTER_SHEET);
  if (!sh) sh = ss.getSheets().filter(x => [RECORD_SHEET, BEST_SHEET].indexOf(x.getName()) < 0)[0];
  if (!sh) throw new Error('"학생명단" 시트가 없습니다.');

  const values = sh.getDataRange().getValues();
  // 머리글 줄: 위에서 10줄 안에 "이름"이 있는 첫 줄
  for (let r = 0; r < Math.min(10, values.length); r++) {
    const c = headerCols_(values[r]);
    if (c.name < 0) continue;
    const list = [];
    for (let i = r + 1; i < values.length; i++) {
      const row = values[i];
      const name = normName_(row[c.name]);
      if (!name) continue;
      const s = { row: i + 1, name: name, grade: cell_(row, c.grade), cls: cell_(row, c.cls), num: cell_(row, c.num),
                  homeroom: cell_(row, c.homeroom), hash: cell_(row, c.pass) };
      s.key = key_(s);
      list.push(s);
    }
    return { sheet: sh, headerRow: r + 1, cols: c, list: list };
  }
  throw new Error('"학생명단" 시트 첫 줄에 "이름" 열이 필요합니다.');
}

function headerCols_(row) {
  const c = { name: -1, grade: -1, cls: -1, num: -1, homeroom: -1, pass: -1 };
  row.forEach((v, i) => {
    const h = String(v).replace(/\s/g, '');
    if (c.name < 0 && /^(이름|성명|학생명|학생이름)$/.test(h)) c.name = i;
    else if (c.homeroom < 0 && /담임/.test(h)) c.homeroom = i;
    else if (c.pass < 0 && /비밀번호/.test(h)) c.pass = i;
    else if (c.grade < 0 && h === '학년') c.grade = i;
    else if (c.cls < 0 && h === '반') c.cls = i;
    else if (c.num < 0 && /^(번호|번)$/.test(h)) c.num = i;
  });
  return c;
}

// "비밀번호(자동)" 열 번호 (없으면 맨 오른쪽에 만든다)
function passCol_(r) {
  if (r.cols.pass >= 0) return r.cols.pass + 1;
  const col = r.sheet.getLastColumn() + 1;
  r.sheet.getRange(r.headerRow, col).setValue(PASS_HEADER).setFontWeight('bold');
  r.cols.pass = col - 1;
  return col;
}

function info_(s) { return { name: s.name, label: label_(s) }; }

function label_(s) {
  return [s.grade && s.grade + '학년', s.cls && s.cls + '반', s.num && s.num + '번'].filter(Boolean).join(' ');
}

function key_(s) { return [s.grade, s.cls, s.num, s.name].join('|'); }

/* ================= 기록 시트 ================= */

function recordSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(RECORD_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RECORD_SHEET);
    sh.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS])
      .setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange('G:H').setNumberFormat('0.00');
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

function recordRows_(withExcluded) {
  const sh = SpreadsheetApp.getActive().getSheetByName(RECORD_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues();
  const h = v[0].map(x => String(x).trim());
  const I = {};
  ['측정일시', '학년', '반', '번호', '이름', '코스', '기록(초)', '목표(초)', '결과', '기록ID', '제외'].forEach(n => { I[n] = h.indexOf(n); });
  return v.slice(1).map(r => {
    const s = { grade: cell_(r, I['학년']), cls: cell_(r, I['반']), num: cell_(r, I['번호']), name: normName_(r[I['이름']]) };
    return {
      key: key_(s), name: s.name, grade: s.grade, cls: s.cls, num: s.num,
      at: r[I['측정일시']] instanceof Date ? r[I['측정일시']] : null,
      course: String(r[I['코스']] || '').trim(),
      sec: Number(r[I['기록(초)']]) || 0,
      target: Number(r[I['목표(초)']]) || 0,
      result: String(r[I['결과']] || ''),
      id: String(r[I['기록ID']] || ''),
      excluded: I['제외'] >= 0 && String(r[I['제외']] || '').trim() !== ''
    };
  }).filter(r => r.name && r.course && r.sec > 0 && (withExcluded || !r.excluded));
}

// 한 학생의 기록 요약: 코스별 최고 기록 + 최근 10회
function summary_(s) {
  const tz = tz_();
  const mine = recordRows_().filter(r => r.key === s.key);
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

// 학생 × 코스별 최고 기록 (명단 순서, 아직 안 뛴 학생도 포함)
function bestData_(r, rows) {
  const courses = COURSES.slice();
  rows.forEach(x => { if (courses.indexOf(x.course) < 0) courses.push(x.course); });
  const stats = {};
  rows.forEach(x => {
    const s = stats[x.key] || (stats[x.key] = { best: {}, count: 0, last: null });
    s.count++;
    if (x.at && (!s.last || x.at > s.last)) s.last = x.at;
    if (!(x.course in s.best) || x.sec < s.best[x.course]) s.best[x.course] = x.sec;
  });
  const list = r.list.map(st => {
    const s = stats[st.key] || { best: {}, count: 0, last: null };
    return { grade: st.grade, cls: st.cls, num: st.num, name: st.name, key: st.key, hasPassword: !!st.hash,
             best: s.best, count: s.count, last: s.last };
  });
  return { courses: courses, list: list };
}

function rebuildBest_() {
  const ss = SpreadsheetApp.getActive();
  const d = bestData_(roster_(), recordRows_());
  const header = ['학년', '반', '번호', '이름']
    .concat(d.courses.map(c => c + ' 최고(초)'), ['측정 횟수', '최근 측정']);
  const out = [header].concat(d.list.map(b => [b.grade, b.cls, b.num, b.name]
    .concat(d.courses.map(c => (c in b.best ? b.best[c] : '')), [b.count, b.last || ''])));

  const sh = ss.getSheetByName(BEST_SHEET) || ss.insertSheet(BEST_SHEET);
  sh.clear();
  sh.getRange(1, 1, out.length, header.length).setValues(out);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#e8f0fe');
  sh.setFrozenRows(1);
  if (out.length > 1) {
    sh.getRange(2, 5, out.length - 1, d.courses.length).setNumberFormat('0.00');
    sh.getRange(2, header.length, out.length - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
}

/* ================= 기록 시간 (선생님이 시작 · 종료) ================= */

function state_() {
  try {
    const s = JSON.parse(PropertiesService.getScriptProperties().getProperty('REC_STATE') || '');
    if (s && typeof s === 'object') return s;
  } catch (_) {}
  return { open: false, start: 0, sessions: [] };
}

function setState_(s) { PropertiesService.getScriptProperties().setProperty('REC_STATE', JSON.stringify(s)); }

function startRec_() {
  const s = state_();
  if (!s.open) { s.open = true; s.start = Date.now(); setState_(s); }
  return s;
}

function stopRec_() {
  const s = state_();
  if (s.open) {
    s.sessions = (s.sessions || []).concat([{ start: s.start, end: Date.now() }]).slice(-20);
    s.open = false;
    setState_(s);
  }
  return s;
}

// 받아도 되는 기록인지: 지금 기록 중이거나, 측정 시각이 지난 기록 시간 안이면(와이파이가 끊겨 늦게 도착한 기록)
function inSession_(at) {
  const s = state_(), slack = 5000;   // 기기·서버 시계 차이만큼만 허용
  if (s.open && at >= s.start - slack) return true;
  return (s.sessions || []).some(x => at >= x.start - slack && at <= x.end + slack);
}

function statusOut_() {
  const s = state_();
  return { recording: !!s.open, since: s.open ? s.start : null };
}

/* ================= 선생님 페이지 ================= */

function teacherHash_() { return PropertiesService.getScriptProperties().getProperty('TEACHER_HASH') || ''; }

function teacherSign_() {
  return hex_(Utilities.computeHmacSha256Signature('teacher|' + teacherHash_(), secret_(), Utilities.Charset.UTF_8)).slice(0, 32);
}

function teacherLogin_(p) {
  if (!teacherHash_()) return { ok: false, error: '시트 메뉴 [러닝 타이머 → 선생님 비밀번호 정하기]에서 비밀번호를 먼저 정해 주세요.' };
  if (fails_('#teacher') >= MAX_FAILS) return { ok: false, error: MSG_LOCKED };
  if (!checkHash_(String(p.password || '').trim(), teacherHash_())) {
    addFail_('#teacher');
    return { ok: false, error: '선생님 비밀번호가 맞지 않아요.' };
  }
  clearFails_('#teacher');
  return { ok: true, token: teacherSign_() };
}

function teacher_(p) {
  if (!teacherHash_() || String(p.token || '') !== teacherSign_()) {
    return { ok: false, relogin: true, error: '선생님 로그인이 필요해요.' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (p.op === 'start') startRec_();
    else if (p.op === 'stop') stopRec_();
    else if (p.op === 'resetPassword') resetKey_(String(p.key || ''));
    else if (p.op === 'exclude') setExcluded_(String(p.id || ''), !!p.on);
    else if (p.op !== 'board') return { ok: false, error: '알 수 없는 요청입니다.' };
  } finally {
    lock.releaseLock();
  }
  return board_();
}

function board_() {
  const tz = tz_();
  const st = state_();
  const r = roster_();
  const all = recordRows_(true);
  const last = (st.sessions || []).slice(-1)[0];
  const since = st.open ? st.start : (last ? last.start : 0);
  const until = st.open ? Infinity : (last ? last.end + 5000 : Infinity);
  const recent = all.filter(x => x.at && x.at.getTime() >= since - 5000 && x.at.getTime() <= until)
    .slice(-300).reverse().map(x => ({
      id: x.id, at: Utilities.formatDate(x.at, tz, 'HH:mm:ss'), who: label_(x), name: x.name,
      course: x.course, sec: x.sec, result: x.result, excluded: x.excluded
    }));
  const d = bestData_(r, all.filter(x => !x.excluded));
  return {
    ok: true, mode: 'sheet', recording: !!st.open, since: st.open ? st.start : null,
    lastSession: last || null, courses: d.courses,
    best: d.list.map(b => ({ grade: b.grade, cls: b.cls, num: b.num, name: b.name, key: b.key,
                             hasPassword: b.hasPassword, best: b.best, count: b.count })),
    recent: recent, total: all.filter(x => !x.excluded).length, sheetUrl: SpreadsheetApp.getActive().getUrl()
  };
}

function resetKey_(key) {
  const r = roster_();
  const s = r.list.filter(x => x.key === key)[0];
  if (s && s.hash) r.sheet.getRange(s.row, passCol_(r)).clearContent();
}

function setExcluded_(id, on) {
  if (!id) return;
  const sh = recordSheet_();
  const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x).trim());
  const idCol = h.indexOf('기록ID') + 1;
  let exCol = h.indexOf('제외') + 1;
  if (!idCol || sh.getLastRow() < 2) return;
  if (!exCol) { exCol = h.length + 1; sh.getRange(1, exCol).setValue('제외').setFontWeight('bold'); }
  const ids = sh.getRange(2, idCol, sh.getLastRow() - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i][0] === id) { sh.getRange(i + 2, exCol).setValue(on ? 'O' : ''); break; }
  }
  rebuildBest_();
}

/* ================= 시트 메뉴 ================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('러닝 타이머')
    .addItem('시트 준비하기 (처음 한 번)', 'setup')
    .addItem('선생님 비밀번호 정하기', 'setTeacherPassword')
    .addSeparator()
    .addItem('기록 시작', 'startRecording')
    .addItem('기록 종료', 'stopRecording')
    .addSeparator()
    .addItem('선택한 학생 비밀번호 초기화', 'resetSelected')
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
    sh.getRange(1, 1, 2, 6).setValues([
      ['학년', '반', '번호', '이름', '담임', PASS_HEADER],
      [3, 1, 1, '홍길동', '이순신', '']
    ]);
    sh.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
  }
  recordSheet_();
  rebuildBest_();
  ss.toast('학생명단에 학생과 담임 선생님 성함을 입력한 뒤 웹 앱으로 배포하세요.', '러닝 타이머 준비 완료', 8);
}

// 학생명단에서 선택한 줄의 학생들 비밀번호를 지워 담임 성함으로 다시 로그인하게 한다
function resetSelected() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  const sel = ss.getActiveRange();
  const r = roster_();
  if (!sel || sel.getSheet().getName() !== r.sheet.getName()) {
    ui.alert('학생명단 시트에서 초기화할 학생의 줄을 선택한 뒤 다시 눌러 주세요.');
    return;
  }
  const from = sel.getRow(), to = sel.getLastRow();
  const targets = r.list.filter(s => s.row >= from && s.row <= to);
  if (!targets.length) { ui.alert('선택한 줄에 학생이 없어요.'); return; }
  const names = targets.map(s => s.name).join(', ');
  if (ui.alert('비밀번호 초기화', names + '\n\n이 학생들은 다음 로그인 때 담임 선생님 성함으로 들어와 새 비밀번호를 만들어요.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  const col = passCol_(r);
  targets.forEach(s => r.sheet.getRange(s.row, col).clearContent());
  ss.toast(targets.length + '명의 비밀번호를 초기화했어요.', '러닝 타이머', 5);
}

function setTeacherPassword() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('선생님 비밀번호', '선생님 페이지(기록 시작·종료)에서 쓸 비밀번호를 입력하세요. 6자 이상.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const pw = r.getResponseText().trim();
  if (pw.length < 6) { ui.alert('6자 이상으로 정해 주세요.'); return; }
  PropertiesService.getScriptProperties().setProperty('TEACHER_HASH', makeHash_(pw));
  SpreadsheetApp.getActive().toast('선생님 비밀번호를 정했어요. 이전에 로그인한 선생님 페이지는 다시 로그인해야 해요.', '러닝 타이머', 6);
}

function startRecording() {
  startRec_();
  SpreadsheetApp.getActive().toast('지금부터 측정한 기록이 저장돼요.', '기록 시작', 5);
}

function stopRecording() {
  stopRec_();
  SpreadsheetApp.getActive().toast('이제 측정해도 기록이 저장되지 않아요.', '기록 종료', 5);
}

function rebuildBest() {
  rebuildBest_();
  SpreadsheetApp.getActive().toast('최고기록을 다시 계산했습니다.', '러닝 타이머', 5);
}

/* ================= 암호화 · 토큰 ================= */

function hex_(bytes) { return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''); }

function sha_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

// 비밀번호는 "소금$해시" 형태로만 저장 (선생님도 원래 비밀번호를 알 수 없음)
function makeHash_(pw) {
  const salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  return salt + '$' + sha_(salt + pw);
}

function checkHash_(pw, stored) {
  const i = String(stored).indexOf('$');
  if (i < 1) return false;
  return sha_(stored.slice(0, i) + pw) === stored.slice(i + 1);
}

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}

// 로그인 증표: 비밀번호가 바뀌거나 초기화되면 자동으로 무효
function sign_(s) {
  return hex_(Utilities.computeHmacSha256Signature(s.key + '|' + s.hash, secret_(), Utilities.Charset.UTF_8)).slice(0, 32);
}

function token_(s) { return s.key + ':' + sign_(s); }

function fromToken_(t) {
  t = String(t || '');
  const i = t.lastIndexOf(':');
  if (i < 1) return null;
  const key = t.slice(0, i), sig = t.slice(i + 1);
  const s = roster_().list.filter(x => x.key === key && x.hash)[0];
  return s && sign_(s) === sig ? s : null;
}

/* ================= 비밀번호 틀린 횟수 제한 ================= */

function fails_(name) { return Number(CacheService.getScriptCache().get('fail:' + name) || 0); }
function addFail_(name) { CacheService.getScriptCache().put('fail:' + name, String(fails_(name) + 1), 600); }
function clearFails_(name) { CacheService.getScriptCache().remove('fail:' + name); }

/* ================= 도우미 ================= */

function tz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || Session.getScriptTimeZone(); }
function normName_(v) { return String(v == null ? '' : v).replace(/\s/g, ''); }
function cell_(row, i) { return i >= 0 && row[i] !== '' && row[i] != null ? String(row[i]).trim() : ''; }

// "김민수", "김 민수", "김민수 선생님", "김민수쌤" 모두 같은 담임으로 인정
function normTeacher_(v) {
  return String(v == null ? '' : v).replace(/\s/g, '').replace(/(선생님|선생|쌤|샘)$/, '');
}
