const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../apps-script/Code.gs'), 'utf8');

function app() {
  let now = 1800000000000;
  const properties = {};
  const rows = [];
  const students = {
    a: { key: 'a', grade: '2', cls: '1', num: '1', name: '가학생' },
    b: { key: 'b', grade: '2', cls: '2', num: '1', name: '나학생' },
    c: { key: 'c', grade: '3', cls: '1', num: '1', name: '다학생' }
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const ctx = vm.createContext({ Date: Clock,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties[key], setProperty: (key, value) => { properties[key] = value; }
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
  });
  vm.runInContext(source, ctx);
  Object.assign(ctx, {
    roster_: () => ({ list: Object.values(students) }),
    fromToken_: token => students[token],
    recordSheet_: () => ({ appendRow: row => rows.push(row), getLastRow: () => rows.length,
      getRange: () => ({ setNumberFormat() {} }) }),
    isDuplicate_: (_, id) => rows.some(row => row[10] === id),
    summary_: () => ({}), rebuildBest_() {}, rebuildEval_() {}
  });
  return { ctx, rows, advance: ms => { now += ms; }, now: () => now,
    save(token, at = now, id = String(rows.length)) {
      return ctx.save_({ token, at, id, course: '장애물', sec: 6, classKey: '2-1' });
    } };
}

test('starting requires a real roster class and cannot switch an active session', () => {
  const { ctx } = app();
  assert.throws(() => ctx.startRec_(), /반/);
  assert.throws(() => ctx.startRec_('9-9'), /반/);
  assert.equal(ctx.state_().open, false);
  ctx.startRec_('2-1');
  assert.equal(ctx.statusOut_().classKey, '2-1');
  assert.throws(() => ctx.startRec_('2-2'), /기록 종료/);
  assert.equal(ctx.state_().classKey, '2-1');
});

test('save accepts only authenticated students in the selected grade and class', () => {
  const a = app();
  a.ctx.startRec_('2-1');
  assert.equal(a.save('a').ok, true);
  assert.equal(a.save('b').classMismatch, true);
  assert.equal(a.save('c').classMismatch, true);
  assert.equal(a.rows.length, 1);
});

test('late upload is checked against its original session after switching classes', () => {
  const a = app();
  a.ctx.startRec_('2-1');
  a.advance(10000);
  const recordedAt = a.now();
  a.advance(1000);
  a.ctx.stopRec_();
  a.advance(1000);
  a.ctx.startRec_('2-2');
  assert.equal(a.save('a', recordedAt).ok, true);
  assert.equal(a.save('b', recordedAt).classMismatch, true);
  assert.equal(a.save('a', a.now(), 'wrong-current').classMismatch, true);
  assert.equal(a.save('b', a.now(), 'right-current').ok, true);
  assert.equal(a.rows[0][12].getTime(), a.ctx.state_().sessions[0].start);
});

test('overlapping clock allowances cannot turn another class session into an allowed one', () => {
  const a = app();
  a.ctx.startRec_('2-1');
  a.advance(1000);
  const beforeSwitch = a.now();
  a.ctx.stopRec_();
  a.advance(1);
  a.ctx.startRec_('2-2');
  assert.equal(a.save('a', beforeSwitch).ok, true);
  assert.equal(a.save('b', beforeSwitch).classMismatch, true);
  assert.equal(a.save('a', a.now(), 'a-now').classMismatch, true);
});

test('closed sessions retain their class and late uploads remain valid', () => {
  const a = app();
  a.ctx.startRec_('2-1');
  a.advance(10000);
  const recordedAt = a.now();
  a.ctx.stopRec_();
  a.advance(20000);
  assert.equal(a.ctx.statusOut_().recording, false);
  assert.equal(a.save('a', recordedAt).ok, true);
  assert.equal(a.save('b', recordedAt).classMismatch, true);
  assert.equal(a.save('a', a.now(), 'closed').closed, true);
});

test('legacy sessions without a selected class cannot save new records', () => {
  const a = app();
  a.ctx.setState_({ open: true, start: a.now(), sessions: [] });
  assert.equal(a.save('a').classMismatch, true);
  assert.equal(a.rows.length, 0);
});
