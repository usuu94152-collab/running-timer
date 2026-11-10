/* 학생 로그인 + 기록 저장 (구글 시트 또는 선생님 컴퓨터의 로컬 서버)
 *
 * - 처음: 이름 + 담임 선생님 성함(임시 비밀번호) → 바로 내 비밀번호 만들기
 *   이후: 이름 + 내 비밀번호
 * - 한 기기(크롬북)에 여러 학생이 미리 로그인해 두고, 수업 때는 이름 버튼만 눌러 바로 측정
 *   (로그인은 이 기기에 남아 다음 수업에도 그대로. [편집]으로 학생을 뺄 수 있음)
 * - 선생님이 [기록 시작]을 누른 동안만 저장 (선생님 페이지 teacher.html)
 * - 평가 코스와 관계없이 모든 코스를 탭으로 선택할 수 있음 (평가는 설정된 코스만 집계)
 * - 스톱워치 위에 이번 기록 시간의 연습 횟수와 우수기록 합산 표시 (등급은 보여 주지 않음)
 * - 정지를 누르면(코스 페이지가 보내는 'run:finish' 이벤트) 기록을 저장
 * - 인터넷이 끊겨도 기록은 이 브라우저에 보관했다가 연결되면 다시 보냄
 * - 페이지 아래 "나의 기록"에 코스별 최고 기록과 최근 기록 표시
 *
 * 코스 페이지와의 약속
 *   window.RunStudent.canRun()   : 타이머를 시작해도 되는지 (로그인 전이면 false)
 *   'run:finish'  (document)     : detail = { course, ms, target, result, laps }
 *   'student:change' (document)  : 학생이 바뀌면 보냄 → 코스 페이지는 타이머 리셋
 */
(() => {
  const API = String(window.RUNNING_SHEET_URL || '').trim();
  const DEVICE_KEY = 'running-timer-device';         // 이 기기에 로그인한 학생들 { students, active }
  const QUEUE_KEY = 'running-timer-queue';
  const MAX_STUDENTS = 8;

  const storage = kind => { try { return window[kind]; } catch (_) { return null; } };
  const L = storage('localStorage');
  const load = (st, k) => { try { return JSON.parse((st && st.getItem(k)) || 'null'); } catch (_) { return null; } };
  const keep = (st, k, v) => { try { if (!st) return; v == null ? st.removeItem(k) : st.setItem(k, JSON.stringify(v)); } catch (_) {} };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normName = v => String(v || '').replace(/\s/g, '');
  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const secText = n => (Math.round(n * 100) / 100).toFixed(2);
  const fine = () => matchMedia('(pointer:fine)').matches;

  // 코스 이름은 내비게이션 링크 글자를 그대로 사용 (예: "301번 버스")
  const courseLinks = Array.from(document.querySelectorAll('.nav ul a[href$=".html"]'));
  const current = document.querySelector('.nav ul a[aria-current]');
  const COURSE = current ? current.textContent.trim() : document.title;

  const device = (API && load(L, DEVICE_KEY)) || {};
  let crew = (device.students || []).filter(x => x && x.token && x.name);   // [{ name, label, token }]
  let student = crew.find(x => x.token === device.active) || crew[0] || null;
  let practice = false;                               // 서버에 연결 못 할 때 저장 없이 연습
  let records = null;
  const recCache = {};                                // token → 나의 기록 (학생을 바꿀 때 바로 보여 주기)
  let pending = null;                                 // 첫 로그인: { name, label, password(임시) }
  let adding = false;                                 // 학생이 있는데 [＋ 학생]으로 로그인 창을 연 상태
  let editing = false;                                // 이름 버튼에 빼기(×) 표시
  let recording = null;                               // 선생님 기록 시간: true / false / null(모름)
  let recordingClass = '', recordingSince = null;
  const otherClass = () => !!(recording && recordingClass && student && student.classKey && student.classKey !== recordingClass);
  const classText = () => {
    const parts = recordingClass.split('-');
    return parts.length === 2 ? `${parts[0]}학년 ${parts[1]}반` : `${recordingClass}반`;
  };
  const saveDevice = () => keep(L, DEVICE_KEY, { students: crew, active: student ? student.token : null });

  /* ================= 서버 호출 ================= */
  // text/plain 본문의 POST는 CORS 사전 요청이 없어 Apps Script 웹 앱과 바로 통신됨
  async function call(action, data){
    const ctrl = window.AbortController ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 20000);
    try {
      const res = await fetch(API, { method: 'POST', body: JSON.stringify(Object.assign({ action }, data)), redirect: 'follow', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ================= 화면 만들기 ================= */
  // 비밀번호 칸: 아이폰은 type=password 에서 한글 입력이 안 되므로(담임 성함은 한글)
  // 글자 칸을 점으로 가리고, "보기" 버튼으로 확인할 수 있게 한다
  const pwField = (id, label, placeholder) => `
    <label class="gate__field"><span>${label}</span>
      <span class="gate__pw">
        <input id="${id}" class="is-masked" type="text" placeholder="${placeholder}" maxlength="20"
               autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button type="button" class="gate__eye" data-eye="${id}" aria-label="비밀번호 보기">보기</button>
      </span></label>`;

  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <form class="gate__card" id="gateForm" novalidate>
      <span class="gate__tag">${esc(COURSE)}</span>
      <h2 class="gate__title" id="gateTitle">학생 로그인</h2>
      <p class="gate__sub">처음이면 비밀번호에 <b>담임 선생님 성함</b>을 입력하세요.<br>로그인한 뒤 나만의 비밀번호를 만들어요.</p>
      <label class="gate__field"><span>이름</span>
        <input id="gateName" type="text" placeholder="홍길동" maxlength="20" autocomplete="off" spellcheck="false"></label>
      ${pwField('gatePw', '비밀번호', '처음이면 담임 선생님 성함')}
      <p class="gate__err" id="gateErr" role="alert"></p>
      <button class="gate__btn" id="gateBtn" type="submit">로그인</button>
      <button class="gate__alt" id="gatePractice" type="button" hidden>저장 없이 연습하기</button>
      <button class="gate__alt" id="gateClose" type="button" hidden>닫기</button>
    </form>
    <form class="gate__card" id="setForm" novalidate hidden>
      <span class="gate__tag" id="setWho"></span>
      <h2 class="gate__title">내 비밀번호 만들기</h2>
      <p class="gate__sub">다음부터는 이름과 이 비밀번호로 로그인해요.<br>4~20자, 친구에게 알려 주지 마세요.</p>
      ${pwField('setPw', '새 비밀번호', '4자 이상')}
      ${pwField('setPw2', '새 비밀번호 확인', '한 번 더 입력')}
      <p class="gate__err" id="setErr" role="alert"></p>
      <button class="gate__btn" id="setBtn" type="submit">비밀번호 만들고 시작</button>
      <button class="gate__alt" id="setBack" type="button">처음으로</button>
    </form>`;
  document.body.appendChild(gate);

  const $ = id => gate.querySelector('#' + id);
  const form = $('gateForm'), nameIn = $('gateName'), pwIn = $('gatePw'), errEl = $('gateErr'), btn = $('gateBtn'), practiceBtn = $('gatePractice'), closeBtn = $('gateClose');
  const setForm = $('setForm'), setPw = $('setPw'), setPw2 = $('setPw2'), setErr = $('setErr'), setBtn = $('setBtn'), setWho = $('setWho');

  gate.addEventListener('click', e => {
    const b = e.target.closest('[data-eye]');
    if (!b) return;
    const input = $(b.dataset.eye);
    const hide = !input.classList.contains('is-masked');
    input.classList.toggle('is-masked', hide);
    b.textContent = hide ? '보기' : '숨기기';
    input.focus();
  });

  // 스톱워치 카드 맨 위: 지금 측정 중인 학생
  const sw = document.getElementById('sw');
  const who = document.createElement('div');
  who.className = 'who';
  who.innerHTML = `<span class="who__ava" aria-hidden="true"></span><span class="who__text"><b id="whoName"></b><small id="whoSub"></small></span><button type="button" id="whoBtn">＋ 학생</button>`;
  const crewEl = document.createElement('div');
  crewEl.className = 'crew';
  crewEl.innerHTML = `
    <div class="crew__head"><span class="crew__rec" id="recBadge"></span><button type="button" id="crewEdit">편집</button></div>
    <div class="crew__chips" id="crewChips"></div>
    <p class="crew__note" id="crewNote" role="status"></p>
    <p class="crew__today" id="crewToday" hidden></p>`;
  if (sw) { sw.prepend(crewEl); sw.prepend(who); }
  const recBadge = crewEl.querySelector('#recBadge');
  const crewChips = crewEl.querySelector('#crewChips');
  const crewEdit = crewEl.querySelector('#crewEdit');
  const crewNote = crewEl.querySelector('#crewNote');
  const crewToday = crewEl.querySelector('#crewToday');
  const whoName = who.querySelector('#whoName');
  const whoSub = who.querySelector('#whoSub');
  const whoBtn = who.querySelector('#whoBtn');
  const whoAva = who.querySelector('.who__ava');

  // 저장 상태 줄
  const save = document.createElement('div');
  save.className = 'save';
  save.innerHTML = `<span id="saveText"></span><button type="button" id="saveRetry" hidden>다시 보내기</button>`;
  const buzz = document.getElementById('buzz');
  if (buzz) buzz.after(save); else if (sw) sw.append(save);
  const saveText = save.querySelector('#saveText');
  const saveRetry = save.querySelector('#saveRetry');

  // 페이지 아래: 나의 기록
  const mine = document.createElement('section');
  mine.className = 'mine';
  mine.id = 'mine';
  mine.hidden = true;
  mine.innerHTML = `
    <div class="mine__head">
      <div><b>나의 기록</b><h2 id="mineName"></h2></div>
      <span id="mineCount"></span>
    </div>
    <div class="mine__best" id="mineBest"></div>
    <h3 class="mine__sub">최근 측정</h3>
    <ol class="mine__recent" id="mineRecent"></ol>`;
  (document.getElementById('stats') || document.body.lastElementChild).after(mine);

  /* ================= 상태 표시 ================= */
  function setSave(kind, text){
    save.dataset.kind = kind;
    saveText.textContent = text;
    saveRetry.hidden = kind !== 'wait';
  }

  function paint(){
    const open = !!API && !practice && (!student || adding);
    gate.classList.toggle('is-open', open);
    document.body.classList.toggle('needs-login', open);
    form.hidden = !!pending;
    setForm.hidden = !pending;
    closeBtn.hidden = !student;
    $('gateTitle').textContent = student ? '학생 추가' : '학생 로그인';

    if (!API) {
      whoAva.textContent = '!';
      whoName.textContent = '시트 미연결';
      whoSub.textContent = '연습 모드 · 기록이 저장되지 않아요';
      whoBtn.hidden = true;
    } else if (practice) {
      whoAva.textContent = '!';
      whoName.textContent = '연습 모드';
      whoSub.textContent = '기록 서버에 연결되지 않아 저장되지 않아요';
      whoBtn.hidden = false;
      whoBtn.textContent = '로그인';
    } else if (student) {
      whoAva.textContent = student.name.slice(-2);
      whoName.textContent = student.name;
      whoSub.textContent = student.label || '지금 측정할 학생';
      whoBtn.hidden = crew.length >= MAX_STUDENTS;
      whoBtn.textContent = '＋ 학생';
    }
    who.hidden = !API ? false : !(student || practice);

    // 이 기기의 학생 이름 버튼
    crewEl.hidden = !API || practice || !crew.length;
    crewEl.classList.toggle('is-editing', editing);
    crewEdit.textContent = editing ? '완료' : '편집';
    // 같은 이름이 이 기기에 둘 이상이면 반·번호를 붙여 구분 ("나보라 3반 1번")
    const dup = n => crew.filter(x => x.name === n).length > 1;
    const short = l => (String(l || '').match(/\d+반(\s*\d+번)?/) || [''])[0];
    crewChips.innerHTML = crew.map((x, i) =>
      `<button type="button" class="chip${student && x.token === student.token ? ' is-on' : ''}" data-pick="${i}" aria-pressed="${student && x.token === student.token}">` +
      `${esc(x.name)}${dup(x.name) ? `<small>${esc(short(x.label))}</small>` : ''}${editing ? '<i aria-label="빼기">×</i>' : ''}</button>`).join('');
    // 이번 기록 시간의 연습 횟수 · 우수기록 합산
    const pr = records && records.practice;
    const showToday = !!(student && pr && pr.open && recording !== false && !otherClass() && (!pr.course || pr.course === COURSE));
    crewToday.hidden = !showToday;
    if (showToday) {
      const left = pr.topN - pr.count;
      crewToday.innerHTML = `이번 시간 연습 <b>${pr.count}회</b>` + (pr.sum != null
        ? ` · 우수 ${pr.topN}개 합산 <b>${secText(pr.sum)}초</b>`
        : ` · ${left}회 더 뛰면 우수 ${pr.topN}개 합산이 나와요`);
    }
    recBadge.className = 'crew__rec' + (recording ? ' is-on' : recording === false ? ' is-off' : '');
    recBadge.textContent = recording ? (recordingClass ? classText() + ' 기록 중' + (otherClass() ? ' · 나는 연습만 가능' : '') : '기록 중') : recording === false ? '기록 대기 · 선생님이 시작하면 저장돼요' : `이 기기 학생 ${crew.length}명`;

    const q = queue().length;
    if (!API || practice) setSave('off', '');
    else if (q && !flushing) setSave('wait', `저장 대기 ${q}건 · 인터넷 연결을 확인하세요`);
    else if (!save.dataset.kind || save.dataset.kind === 'off' || save.dataset.kind === 'idle') {
      setSave('idle', recording === false ? '지금은 연습만 돼요 (기록 대기 중)' : '정지를 누르면 기록이 자동 저장돼요');
    }

    paintRecords();
  }

  function paintRecords(){
    mine.hidden = !student || !records;
    if (mine.hidden) return;
    mine.querySelector('#mineName').textContent = student.name + (student.label ? ` · ${student.label}` : '');
    mine.querySelector('#mineCount').textContent = `총 ${records.count || 0}회 측정`;

    const best = records.best || {};
    const names = courseLinks.map(a => a.textContent.trim());
    Object.keys(best).forEach(c => { if (names.indexOf(c) < 0) names.push(c); });
    mine.querySelector('#mineBest').innerHTML = names.map(c => {
      const b = best[c];
      const link = courseLinks.find(a => a.textContent.trim() === c);
      const cls = 'mine__tile' + (c === COURSE ? ' is-here' : '') + (b ? (b.result === '성공' ? ' is-ok' : b.result === '실패' ? ' is-fail' : '') : ' is-empty');
      const body = `<span>${esc(c)}</span><strong>${b ? secText(b.sec) + '<em>초</em>' : '—'}</strong><small>${b ? '최고 기록' + (b.result ? ' · ' + esc(b.result) : '') : '아직 기록 없음'}</small>`;
      return link && c !== COURSE ? `<a class="${cls}" href="${esc(link.getAttribute('href'))}">${body}</a>` : `<div class="${cls}">${body}</div>`;
    }).join('');

    const recent = records.recent || [];
    mine.querySelector('#mineRecent').innerHTML = recent.length
      ? recent.map(r => `<li><span class="mine__when">${esc(r.at)}</span><span class="mine__course">${esc(r.course)}</span><b>${secText(r.sec)}초</b><i class="${r.result === '성공' ? 'ok' : r.result === '실패' ? 'fail' : ''}">${esc(r.result || '')}</i></li>`).join('')
      : '<li class="mine__none">첫 기록을 측정해 보세요!</li>';
  }

  /* ================= 로그인 ================= */
  function resetMasks(){
    gate.querySelectorAll('[data-eye]').forEach(b => { $(b.dataset.eye).classList.add('is-masked'); b.textContent = '보기'; });
  }

  const busy = () => !!(sw && sw.classList.contains('is-running'));
  function note(text){ crewNote.textContent = text || ''; clearTimeout(note.t); if (text) note.t = setTimeout(() => { crewNote.textContent = ''; }, 3500); }

  // 로그인 창 열기 (학생 추가). name 을 주면 이름을 미리 채움 (비밀번호가 초기화된 학생)
  function openGate(name){
    if (busy()) { note('측정 중에는 학생을 바꿀 수 없어요.'); return; }
    practice = false; pending = null; adding = true;
    form.reset(); setForm.reset(); resetMasks();
    errEl.textContent = ''; setErr.textContent = ''; practiceBtn.hidden = true;
    if (name) nameIn.value = name;
    paint();
    if (fine()) setTimeout(() => (name ? pwIn : nameIn).focus(), 50);
  }

  function closeGate(){
    adding = false; pending = null;
    paint();
  }

  // 측정할 학생 고르기 (기록 영역도 그 학생 것으로)
  function pick(next){
    if (!next || (student && next.token === student.token)) return;
    if (busy()) { note('측정 중에는 학생을 바꿀 수 없어요. 먼저 정지하세요.'); return; }
    student = next;
    records = recCache[next.token] || null;
    save.dataset.kind = '';
    saveDevice();
    paint();
    document.dispatchEvent(new CustomEvent('student:change', { detail: student }));
    loadRecords(next);
  }

  function drop(token, why){
    crew = crew.filter(x => x.token !== token);
    delete recCache[token];
    if (student && student.token === token) {
      student = crew[0] || null;
      records = student ? recCache[student.token] || null : null;
      document.dispatchEvent(new CustomEvent('student:change', { detail: student }));
      if (student) loadRecords(student);
    }
    if (!crew.length) editing = false;
    saveDevice();
    paint();
    if (why) note(why);
  }

  function loadRecords(x){
    call('records', { token: x.token }).then(j => {
      if (j && j.ok) {
        if (j.student) { Object.assign(x, j.student); saveDevice(); }
        recCache[x.token] = j.records;
        if (student && student.token === x.token) { records = j.records; paint(); }
      } else if (j && j.relogin) {
        drop(x.token, `${x.name} 학생의 비밀번호가 초기화되어 다시 로그인해야 해요.`);
      }
    }).catch(() => {});
  }

  function signedIn(j){
    const me = { name: j.student.name, label: j.student.label || '', classKey: j.student.classKey || '', token: j.token };
    const same = x => x.name === me.name && x.label === me.label;
    const was = crew.findIndex(same);
    if (was >= 0) crew[was] = me; else crew.push(me);
    if (crew.length > MAX_STUDENTS) crew = crew.slice(-MAX_STUDENTS);
    student = me;
    records = j.records || null;
    recCache[me.token] = records;
    pending = null; adding = false;
    saveDevice();
    form.reset(); setForm.reset(); resetMasks();
    save.dataset.kind = '';
    paint();
    document.dispatchEvent(new CustomEvent('student:change', { detail: student }));
    if (document.activeElement) document.activeElement.blur();
    flush();
  }

  function offline(el){
    el.textContent = '기록 서버에 연결할 수 없어요. 와이파이·인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
    practiceBtn.hidden = false;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = normName(nameIn.value);
    const password = pwIn.value.trim();
    if (!name) { errEl.textContent = '이름을 입력해 주세요.'; nameIn.focus(); return; }
    if (!password) { errEl.textContent = '비밀번호를 입력해 주세요. 처음이면 담임 선생님 성함이에요.'; pwIn.focus(); return; }

    errEl.textContent = '';
    btn.disabled = true; btn.textContent = '확인 중…';
    try {
      const j = await call('login', { name, password });
      if (!j || !j.ok) { errEl.textContent = (j && j.error) || '로그인하지 못했어요.'; return; }
      if (j.mustChange) {                       // 첫 로그인: 담임 성함으로 들어옴 → 비밀번호 만들기
        pending = { name: j.student.name, label: j.student.label || '', password };
        setWho.textContent = pending.name + (pending.label ? ' · ' + pending.label : '');
        setErr.textContent = '';
        paint();
        if (fine()) setTimeout(() => setPw.focus(), 50);
        return;
      }
      signedIn(j);
    } catch (_) {
      offline(errEl);
    } finally {
      btn.disabled = false; btn.textContent = '로그인';
    }
  });

  setForm.addEventListener('submit', async e => {
    e.preventDefault();
    const next = setPw.value.trim();
    if (next.length < 4) { setErr.textContent = '비밀번호는 4자 이상으로 만들어 주세요.'; setPw.focus(); return; }
    if (next !== setPw2.value.trim()) { setErr.textContent = '두 비밀번호가 서로 달라요. 다시 입력해 주세요.'; setPw2.focus(); return; }

    setErr.textContent = '';
    setBtn.disabled = true; setBtn.textContent = '저장 중…';
    try {
      const j = await call('setPassword', { name: pending.name, password: pending.password, newPassword: next });
      if (!j || !j.ok) { setErr.textContent = (j && j.error) || '비밀번호를 만들지 못했어요.'; return; }
      signedIn(j);
    } catch (_) {
      setErr.textContent = '기록 서버에 연결할 수 없어요. 잠시 뒤 다시 눌러 주세요.';
    } finally {
      setBtn.disabled = false; setBtn.textContent = '비밀번호 만들고 시작';
    }
  });

  $('setBack').addEventListener('click', () => { pending = null; form.reset(); resetMasks(); paint(); });
  closeBtn.addEventListener('click', closeGate);
  practiceBtn.addEventListener('click', () => { practice = true; adding = false; paint(); });
  whoBtn.addEventListener('click', () => openGate());
  crewEdit.addEventListener('click', () => { editing = !editing; paint(); });
  crewChips.addEventListener('click', e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const x = crew[+b.dataset.pick];
    if (!x) return;
    if (editing) {
      if (busy() && student && x.token === student.token) { note('측정 중인 학생은 뺄 수 없어요.'); return; }
      if (confirm(`${x.name} 학생을 이 기기에서 뺄까요? 다음에 다시 로그인하면 돼요.`)) drop(x.token);
      return;
    }
    pick(x);
  });
  gate.addEventListener('keydown', e => { if (e.key === 'Escape' && student) closeGate(); });

  /* ================= 기록 저장 (오프라인 대기열) ================= */
  const queue = () => load(L, QUEUE_KEY) || [];
  const setQueue = q => keep(L, QUEUE_KEY, q.length ? q : null);
  let flushing = false;

  document.addEventListener('run:finish', e => {
    if (!API || !student) return;
    if (recording === false) { setSave('closed', '기록 시간이 아니라 저장하지 않았어요 (연습)'); return; }
    if (otherClass()) { setSave('class', `지금은 ${classText()} 수업이에요. 저장 없이 연습했어요.`); return; }
    const d = e.detail || {};
    const rec = {
      id: uid(), at: Date.now(), token: student.token,
      course: d.course || COURSE,
      sec: Math.floor((d.ms || 0) / 10) / 100,       // 화면에 보이는 그대로 (1/100초 버림)
      target: d.target ? d.target / 1000 : '',
      result: d.result || '',
      laps: (d.laps || []).map(ms => Math.floor(ms / 10) / 100)
    };
    if (!(rec.sec > 0)) return;
    setQueue(queue().concat(rec));
    flush(rec);
  });

  async function flush(latest){
    if (!API || flushing) return;
    let q = queue().filter(r => r.token);             // 예전 형식(생년월일) 기록은 보낼 수 없음
    setQueue(q);
    if (!q.length) return paint();
    flushing = true;
    setSave('busy', latest ? `${secText(latest.sec)}초 저장 중…` : `기록 ${q.length}건 저장 중…`);
    let lastSaved = null, failed = false, rejected = '', closed = '';
    while (q.length) {
      const rec = q[0];
      try {
        const j = await call('save', rec);
        if (j && j.ok) {
          lastSaved = rec;
          if (j.records) recCache[rec.token] = j.records;
          if (student && rec.token === student.token && j.records) records = j.records;
        } else if (j && j.closed) {
          closed = j.error; recording = false;             // 선생님이 기록을 끝낸 뒤에 잰 기록
        } else {
          rejected = (j && j.error) || '저장하지 못했어요.';   // 비밀번호가 초기화된 경우 등: 다시 보내도 소용없음
          if (j && j.relogin) { const x = crew.find(c => c.token === rec.token); if (x) drop(x.token, `${x.name} 학생은 다시 로그인해야 해요.`); }
        }
        q = queue().filter(r => r.id !== rec.id);
        setQueue(q);
      } catch (_) {
        failed = true;
        break;
      }
    }
    flushing = false;
    if (failed) setSave('wait', `저장 대기 ${q.length}건 · 인터넷 연결을 확인하세요`);
    else if (rejected) setSave('error', rejected);
    else if (closed && !lastSaved) setSave('closed', '기록 시간이 아니라 저장하지 않았어요 (연습)');
    else if (lastSaved) setSave('ok', `✓ ${lastSaved.course} ${secText(lastSaved.sec)}초 · 저장됨`);
    paint();
  }

  saveRetry.addEventListener('click', () => flush());
  addEventListener('online', () => flush());

  /* ================= 선생님 기록 시간 확인 ================= */
  let statusTimer = 0;
  async function checkStatus(){
    clearTimeout(statusTimer);
    if (!API) return;
    try {
      const j = await call('status', {});
      if (j && j.ok && typeof j.recording === 'boolean') {
        const changed = j.recording !== recording || (j.classKey || '') !== recordingClass || j.since !== recordingSince;
        recording = j.recording;
        recordingClass = j.classKey || '';
        recordingSince = j.since;
        if (save.dataset.kind === 'closed' && recording) save.dataset.kind = '';
        if (changed && save.dataset.kind === 'class') save.dataset.kind = '';
        if (changed && recording && student) loadRecords(student);
        paint();
      }
    } catch (_) {}
    if (!document.hidden) statusTimer = setTimeout(checkStatus, 15000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStatus(); });

  /* ================= 코스 페이지에 공개 ================= */
  window.RunStudent = {
    canRun: () => !API || !!student || practice,
    current: () => student
  };

  paint();
  if (API) checkStatus();
  if (student) {
    // 이 기기 학생들의 기록 새로 불러오기 (비밀번호가 초기화된 학생은 목록에서 빠짐)
    crew.forEach(loadRecords);
    flush();
  } else if (API && fine()) {
    setTimeout(() => nameIn.focus(), 50);
  }
})();
