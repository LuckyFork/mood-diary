const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const NOW = new Date(2026, 9, 31, 12).getTime();
const entry = (extra = {}) => ({ id: '1', mood: 'anxious', intensity: 4, triggers: ['工作'], note: '', ts: NOW, ...extra });
const empty = () => ({ version: 2, entries: [], sessions: [] });
function storage(initial = {}, failWrite = false) {
  const data = { ...initial };
  return { data, getItem: k => data[k] ?? null, setItem(k, v) { if (failWrite) throw Error('quota'); data[k] = v; } };
}

test('loads legacy records without writing or deleting their backup', () => {
  const s = storage({ 'mood-diary-v1': JSON.stringify([entry({ id: 123 })]) });
  const result = C.loadState(s);
  assert.equal(result.error, null);
  assert.equal(result.state.entries[0].id, '123');
  assert.equal(s.data['mood-diary-v2'], undefined);
  assert.ok(s.data['mood-diary-v1']);
});

for (const value of ['null', '{}', '{bad', '[{}]']) {
  test(`rejects malformed legacy state ${value} without destroying it`, () => {
    const s = storage({ 'mood-diary-v1': value });
    const result = C.loadState(s);
    assert.ok(result.error);
    assert.equal(result.backup['mood-diary-v1'], value);
    assert.deepEqual(result.state.entries, []);
    assert.equal(s.data['mood-diary-v1'], value);
  });
}

test('corrupt v2 does not silently fall back to legacy and overwrite new data', () => {
  const s = storage({ 'mood-diary-v2': 'null', 'mood-diary-v1': JSON.stringify([entry()]) });
  assert.ok(C.loadState(s).error);
  assert.equal(s.data['mood-diary-v2'], 'null');
});

test('blocked storage reads remain recoverable', () => {
  const result = C.loadState({ getItem() { throw Error('blocked'); } });
  assert.ok(result.error);
  assert.deepEqual(result.state.entries, []);
});

test('failed persistence reports failure and leaves prior data unchanged', () => {
  const s = storage({ 'mood-diary-v2': JSON.stringify(empty()) }, true);
  const result = C.saveState(s, { ...empty(), entries: [entry()] });
  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(s.data['mood-diary-v2']).entries, []);
});

test('persists more than 200 records without truncating or deleting legacy backup', () => {
  const s = storage({ 'mood-diary-v1': '[]' });
  const state = { ...empty(), entries: Array.from({ length: 205 }, (_, i) => entry({ id: String(i) })) };
  assert.equal(C.saveState(s, state).ok, true);
  assert.equal(C.loadState(s).state.entries.length, 205);
  assert.equal(s.data['mood-diary-v1'], '[]');
});

test('entry validation rejects invalid intensity, mood and duplicate ids before writing', () => {
  for (const entries of [[entry({ intensity: 6 })], [entry({ mood: 'unknown' })], [entry(), entry()]]) {
    const s = storage();
    assert.equal(C.saveState(s, { ...empty(), entries }).ok, false);
    assert.equal(s.data['mood-diary-v2'], undefined);
  }
});

test('seven-day window starts at local midnight and excludes future records', () => {
  const start = new Date(2026, 9, 25, 0).getTime();
  const rows = [entry({ id: 'a', ts: start - 1 }), entry({ id: 'b', ts: start }), entry({ id: 'c', ts: NOW }), entry({ id: 'd', ts: NOW + 1 })];
  assert.deepEqual(C.analyze({ ...empty(), entries: rows }, 7, NOW).entries.map(e => e.id), ['c', 'b']);
});

test('trigger associations count moods in the same window and deduplicate tags', () => {
  const rows = [entry({ id: 'a', triggers: ['工作', '工作'] }), entry({ id: 'b', mood: 'happy' }), entry({ id: 'c', triggers: ['睡眠'] }), entry({ id: 'd', triggers: ['家庭'], ts: new Date(2026, 8, 1).getTime() })];
  const result = C.analyze({ ...empty(), entries: rows }, 7, NOW);
  assert.equal(result.ready, true);
  assert.equal(result.triggers[0].tag, '工作');
  assert.equal(result.triggers[0].count, 2);
  assert.equal(result.triggers[0].moods.anxious, 1);
  assert.equal(result.triggers[0].moods.happy, 1);
  assert.equal(result.triggers.some(t => t.tag === '家庭'), false);
});

test('insufficient data is not presented as a recurring pattern', () => {
  const result = C.analyze({ ...empty(), entries: [entry()] }, 7, NOW);
  assert.equal(result.ready, false);
  assert.equal(result.total, 1);
});

test('activity feedback excludes skipped ratings from denominator and retains worse responses', () => {
  const sessions = ['better', 'same', 'worse', 'skipped'].map((feedback, i) => ({ id: String(i), activityId: 'breath', feedback, ts: NOW }));
  const row = C.analyze({ ...empty(), sessions }, 7, NOW).activities[0];
  assert.deepEqual({ completed: row.completed, rated: row.rated, better: row.better, worse: row.worse }, { completed: 4, rated: 3, better: 1, worse: 1 });
});

test('history combines search, mood and trigger filters without hiding old entries', () => {
  const rows = [entry({ id: 'a', note: '评审前紧张', ts: 1 }), entry({ id: 'b', note: '评审顺利', mood: 'happy' }), entry({ id: 'c', triggers: ['睡眠'] })];
  assert.deepEqual(C.filterEntries(rows, { query: '评审', mood: 'anxious', trigger: '工作' }).map(e => e.id), ['a']);
  assert.equal(C.filterEntries(rows, {}).length, 3);
});

test('breathing completes only after the final exhalation, including delayed timer ticks', () => {
  assert.equal(C.activityProgress('breath', 0).phase, '吸气');
  assert.equal(C.activityProgress('breath', 4000).phase, '呼气');
  assert.equal(C.activityProgress('breath', 54000).phase, '呼气');
  assert.equal(C.activityProgress('breath', 59999).done, false);
  assert.equal(C.activityProgress('breath', 60000).done, true);
  assert.equal(C.activityProgress('breath', 90000).remaining, 0);
});

test('sample data is regenerated independently and never mutates personal state', () => {
  const a = C.createSample(NOW), b = C.createSample(NOW);
  a.entries[0].note = 'changed';
  assert.notEqual(b.entries[0].note, 'changed');
  assert.ok(b.entries.length >= 7);
  assert.ok(C.analyze(b, 7, NOW).ready);
});

test('legacy notes longer than the new input limit remain readable and exportable', () => {
  const note = '长'.repeat(2500);
  const s = storage({ 'mood-diary-v1': JSON.stringify([entry({ note })]) });
  const loaded = C.loadState(s);
  assert.equal(loaded.error, null);
  assert.equal(loaded.state.entries[0].note.length, 2500);
  assert.equal(C.saveState(s, loaded.state).ok, true);
  assert.equal(C.loadState(s).state.entries[0].note.length, 2500);
});

test('stale page cannot overwrite another page records', () => {
  const s = storage();
  const pageA = C.loadState(s), pageB = C.loadState(s);
  assert.equal(C.saveState(s, { ...empty(), entries: [entry({ id: 'A' })] }, pageA.revision).ok, true);
  const result = C.saveState(s, { ...empty(), entries: [entry({ id: 'B' })] }, pageB.revision);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(C.loadState(s).state.entries[0].id, 'A');
});

test('cleared data cannot be resurrected by a stale snapshot', () => {
  const s = storage({ 'mood-diary-v2': JSON.stringify({ ...empty(), entries: [entry()] }) });
  const stale = C.loadState(s);
  delete s.data['mood-diary-v2'];
  const result = C.saveState(s, { ...stale.state, entries: [...stale.state.entries, entry({ id: '2' })] }, stale.revision);
  assert.equal(result.ok, false);
  assert.deepEqual(C.loadState(s).state.entries, []);
});

test('resuming breathing uses the remaining phase time and displays all six cycles', () => {
  assert.equal(C.activityProgress('breath', 3500).phaseRemainingMs, 500);
  assert.equal(C.activityProgress('breath', 9000).phaseRemainingMs, 1000);
  assert.equal(C.activityProgress('breath', 50000).cycle, 6);
  assert.equal(C.activityProgress('breath', 50000).totalCycles, 6);
});
