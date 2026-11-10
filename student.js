/* 학생 로그인 + 기록 저장 (구글 시트 또는 선생님 컴퓨터의 로컬 서버)
 *
 * - 이름 + 생년월일로 로그인 (학생명단 시트와 대조)
 * - 정지를 누르면(코스 페이지가 보내는 'run:finish' 이벤트) 기록을 시트에 저장
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
  const SESSION_KEY = 'running-timer-student';
  const QUEUE_KEY = 'running-timer-queue';

  const storage = kind => { try { return window[kind]; } catch (_) { return null; } };
  const S = storage('sessionStorage'), L = storage('localStorage');
  const load = (st, k) => { try { return JSON.parse((st && st.getItem(k)) || 'null'); } catch (_) { return null; } };
  const keep = (st, k, v) => { try { if (!st) return; v == null ? st.removeItem(k) : st.setItem(k, JSON.stringify(v)); } catch (_) {} };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normName = v => String(v || '').replace(/\s/g, '');
  // 생년월일 → YYMMDD (서버와 같은 규칙)
  const birthKey = v => {
    const s = String(v || '').trim();
    const parts = s.split(/\D+/).filter(Boolean);
    if (parts.length === 3) return [parts[0].slice(-2), parts[1], parts[2]].map(x => ('0' + x).slice(-2)).join('');
    let d = s.replace(/\D/g, '');
    if (d.length === 8) d = d.slice(2);
    return d.length === 6 ? d : '';
  };
  const uid = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const secText = n => (Math.round(n * 100) / 100).toFixed(2);

  // 코스 이름은 내비게이션 링크 글자를 그대로 사용 (예: "301번 버스")
  const courseLinks = Array.from(document.querySelectorAll('.nav ul a[href$=".html"]'));
  const current = document.querySelector('.nav ul a[aria-current]');
  const COURSE = current ? current.textContent.trim() : document.title;

  let student = API ? load(S, SESSION_KEY) : null;   // { name, birth, label }
  let practice = false;                               // 시트에 연결 못 할 때 저장 없이 연습
  let records = null;

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
  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <form class="gate__card" id="gateForm" autocomplete="off" novalidate>
      <span class="gate__tag">${esc(COURSE)}</span>
      <h2 class="gate__title">학생 로그인</h2>
      <p class="gate__sub">이름과 생년월일을 입력하면<br>측정한 기록이 선생님 기록부에 저장돼요.</p>
      <label class="gate__field"><span>이름</span>
        <input id="gateName" name="name" type="text" placeholder="홍길동" maxlength="20" required></label>
      <label class="gate__field"><span>생년월일</span>
        <input id="gateBirth" name="birth" type="text" inputmode="numeric" placeholder="예) 120305 또는 20120305" maxlength="10" required></label>
      <p class="gate__err" id="gateErr" role="alert"></p>
      <button class="gate__btn" id="gateBtn" type="submit">로그인</button>
      <button class="gate__alt" id="gatePractice" type="button" hidden>저장 없이 연습하기</button>
    </form>`;
  document.body.appendChild(gate);

  const form = gate.querySelector('#gateForm');
  const nameIn = gate.querySelector('#gateName');
  const birthIn = gate.querySelector('#gateBirth');
  const errEl = gate.querySelector('#gateErr');
  const btn = gate.querySelector('#gateBtn');
  const practiceBtn = gate.querySelector('#gatePractice');

  // 스톱워치 카드 맨 위: 지금 측정 중인 학생
  const sw = document.getElementById('sw');
  const who = document.createElement('div');
  who.className = 'who';
  who.innerHTML = `<span class="who__ava" aria-hidden="true"></span><span class="who__text"><b id="whoName"></b><small id="whoSub"></small></span><button type="button" id="whoBtn">학생 변경</button>`;
  if (sw) sw.prepend(who);
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
    const open = !!API && !student && !practice;
    gate.classList.toggle('is-open', open);
    document.body.classList.toggle('needs-login', open);

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
      whoSub.textContent = student.label || '로그인됨';
      whoBtn.hidden = false;
      whoBtn.textContent = '학생 변경';
    }
    who.hidden = !API ? false : !(student || practice);

    const q = queue().length;
    if (!API || practice) setSave('off', '');
    else if (q && !flushing) setSave('wait', `저장 대기 ${q}건 · 인터넷 연결을 확인하세요`);
    else if (!save.dataset.kind || save.dataset.kind === 'off') setSave('idle', '정지를 누르면 기록이 자동 저장돼요');

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
  function openGate(){
    student = null; practice = false; records = null;
    keep(S, SESSION_KEY, null);
    form.reset(); errEl.textContent = ''; practiceBtn.hidden = true;
    save.dataset.kind = '';
    paint();
    document.dispatchEvent(new CustomEvent('student:change', { detail: null }));
    if (matchMedia('(pointer:fine)').matches) setTimeout(() => nameIn.focus(), 50);
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = normName(nameIn.value);
    const birth = birthKey(birthIn.value);
    if (!name) { errEl.textContent = '이름을 입력해 주세요.'; nameIn.focus(); return; }
    if (!birth) { errEl.textContent = '생년월일을 6자리(예: 120305) 또는 8자리(예: 20120305)로 입력해 주세요.'; birthIn.focus(); return; }

    errEl.textContent = '';
    btn.disabled = true; btn.textContent = '확인 중…';
    try {
      const j = await call('login', { name, birth });
      if (!j || !j.ok) { errEl.textContent = (j && j.error) || '로그인하지 못했어요.'; return; }
      student = { name: j.student.name, birth, label: j.student.label || '' };
      records = j.records || null;
      keep(S, SESSION_KEY, student);
      save.dataset.kind = '';
      paint();
      document.dispatchEvent(new CustomEvent('student:change', { detail: student }));
      if (document.activeElement) document.activeElement.blur();
      flush();
    } catch (_) {
      errEl.textContent = '기록 서버에 연결할 수 없어요. 와이파이·인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
      practiceBtn.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = '로그인';
    }
  });

  practiceBtn.addEventListener('click', () => { practice = true; paint(); });
  whoBtn.addEventListener('click', openGate);

  /* ================= 기록 저장 (오프라인 대기열) ================= */
  const queue = () => load(L, QUEUE_KEY) || [];
  const setQueue = q => keep(L, QUEUE_KEY, q.length ? q : null);
  let flushing = false;

  document.addEventListener('run:finish', e => {
    if (!API || !student) return;
    const d = e.detail || {};
    const rec = {
      id: uid(), at: Date.now(),
      name: student.name, birth: student.birth,
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
    let q = queue();
    if (!q.length) return paint();
    flushing = true;
    setSave('busy', latest ? `${secText(latest.sec)}초 저장 중…` : `기록 ${q.length}건 저장 중…`);
    let lastSaved = null, failed = false, rejected = '';
    while (q.length) {
      const rec = q[0];
      try {
        const j = await call('save', rec);
        if (j && j.ok) {
          lastSaved = rec;
          if (student && rec.name === student.name && rec.birth === student.birth && j.records) records = j.records;
        } else {
          rejected = (j && j.error) || '저장하지 못했어요.';   // 명단에 없는 등: 다시 보내도 소용없으니 버림
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
    else if (lastSaved) setSave('ok', `✓ ${lastSaved.course} ${secText(lastSaved.sec)}초 · 저장됨`);
    paint();
  }

  saveRetry.addEventListener('click', () => flush());
  addEventListener('online', () => flush());

  /* ================= 코스 페이지에 공개 ================= */
  window.RunStudent = {
    canRun: () => !API || !!student || practice,
    current: () => student
  };

  paint();
  if (student) {
    // 다른 코스 페이지로 이동해 왔을 때: 기록 새로 불러오기
    call('records', { name: student.name, birth: student.birth })
      .then(j => { if (j && j.ok) { records = j.records; paint(); } else if (j && !j.ok) openGate(); })
      .catch(() => {});
    flush();
  } else if (API && matchMedia('(pointer:fine)').matches) {
    setTimeout(() => nameIn.focus(), 50);
  }
})();
