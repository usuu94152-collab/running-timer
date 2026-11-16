const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(require('node:path').join(__dirname, '../apps-script/Code.gs'), 'utf8');
const student = { grade: '2', cls: '1', num: '16', name: '테스트학생', key: '2|1|16|테스트학생' };

function app(runs, minSec = 5) {
  const session = new Date('2026-11-10T01:00:00Z');
  const header = ['측정일시', '학년', '반', '번호', '이름', '코스', '기록(초)', '목표(초)', '결과', '기록ID', '제외', '기록시간'];
  const values = [header, ...runs.map((r, i) => [
    session, '2', '1', '16', r.name || student.name, r.course || '장애물', r.sec, 10,
    '성공', String(i), r.excluded ? 'O' : '', session
  ])];
  const sheet = { getLastRow: () => values.length, getDataRange: () => ({ getValues: () => values }) };
  const context = vm.createContext({
    Date,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => sheet }) },
    Utilities: { formatDate: () => '11/10 10:00' }
  });
  vm.runInContext(source, context);
  context.criteria_ = () => ({ course: '장애물', minSec });
  context.state_ = () => ({ open: true, start: session.getTime() });
  context.tz_ = () => 'Asia/Seoul';
  return context;
}

test('existing invalid fastest record is replaced by the best valid record', () => {
  const ctx = app([{ sec: 2.02 }, { sec: 5.64 }, { sec: 6.1 }, { sec: 4.99 }]);
  const summary = ctx.summary_(student);
  assert.equal(summary.best['장애물'].sec, 5.64);
  assert.equal(summary.practice.count, 2);
  assert.equal(summary.count, 4);
  assert.equal(summary.recent.length, 4);
  assert.equal(summary.recent[0].sec, 4.99);
  const teacher = ctx.bestData_({ list: [student] }, ctx.recordRows_()).list[0];
  assert.equal(teacher.best['장애물'], 5.64);
  assert.equal(teacher.count, 4);
});

test('exactly the minimum is valid; excluded and other students records stay out', () => {
  const ctx = app([{ sec: 4.99 }, { sec: 5 }, { sec: 5.1 },
    { sec: 5, excluded: true, course: '지그재그' }, { sec: 5, name: '다른학생', course: '이어달리기' }]);
  const summary = ctx.summary_(student);
  assert.equal(summary.best['장애물'].sec, 5);
  assert.equal(summary.practice.count, 2);
  assert.equal(summary.best['지그재그'], undefined);
  assert.equal(summary.best['이어달리기'], undefined);
});

test('only invalid records produce no best record, while retaining measurement history', () => {
  const ctx = app([{ sec: 2.02 }, { sec: 4.99 }]);
  const summary = ctx.summary_(student);
  assert.equal(Object.keys(summary.best).length, 0);
  assert.equal(summary.count, 2);
  assert.equal(summary.practice.count, 0);
  assert.equal(Object.keys(ctx.bestData_({ list: [student] }, ctx.recordRows_()).list[0].best).length, 0);
});

test('the configured minimum applies to every course and can be changed', () => {
  const ctx = app([{ sec: 5 }, { sec: 7 }, { sec: 6.9, course: '지그재그' }, { sec: 8, course: '지그재그' }], 7);
  let summary = ctx.summary_(student);
  assert.equal(summary.best['장애물'].sec, 7);
  assert.equal(summary.best['지그재그'].sec, 8);
  assert.equal(summary.practice.count, 1);
  ctx.criteria_ = () => ({ course: '', minSec: 0 });
  summary = ctx.summary_(student);
  assert.equal(summary.best['장애물'].sec, 5);
  assert.equal(summary.best['지그재그'].sec, 6.9);
  assert.equal(summary.practice.count, 4);
});

test('record grade uses the single fastest valid run of that hour', () => {
  const ctx = app([{ sec: 4.2 }, { sec: 12.4 }, { sec: 11.6 }, { sec: 10.9, excluded: true }, { sec: 9, course: '지그재그' }, { sec: 13.1 }]);
  const cfg = { course: '장애물', minSec: 5, practice: { A: 5, B: 4, C: 3 },
                cut: { '남': { A: 11, B: 12, C: 13 }, '여': { A: 12, B: 13, C: 14 } } };
  const roster = { list: [{ ...student, sex: '남' }, { ...student, sex: '여' }] };
  const [boy, girl] = ctx.evaluate_(roster, ctx.recordRows_(), cfg);
  assert.equal(boy.count, 3);            // 4.2 is invalid, 10.9 excluded, 지그재그 is another course
  assert.equal(boy.practice, 'C');
  assert.equal(boy.best, 11.6);          // fastest valid run, not a sum
  assert.equal(boy.record, 'B');         // 남: 11.6 <= 12
  assert.equal(girl.record, 'A');        // 여: 11.6 <= 12
  assert.equal(ctx.summary_(student).practice.best, 11.6);
});

test('a student with no valid run gets D and no best record', () => {
  const ctx = app([{ sec: 3 }]);
  const cfg = { course: '장애물', minSec: 5, practice: { A: 5, B: 4, C: 3 },
                cut: { '남': { A: 11, B: 12, C: 13 }, '여': { A: 12, B: 13, C: 14 } } };
  const [e] = ctx.evaluate_({ list: [{ ...student, sex: '남' }] }, ctx.recordRows_(), cfg);
  assert.equal(e.best, null);
  assert.equal(e.record, 'D');
  assert.equal(e.practice, 'D');
  assert.equal(ctx.summary_(student).practice.best, null);
});
