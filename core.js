(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoodCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'mood-diary-v2';
  const LEGACY_KEY = 'mood-diary-v1';
  const MOODS = [
    { key: 'happy', emoji: '😄', label: '开心', color: '#dbab58', soft: '#fff4dc' },
    { key: 'calm', emoji: '😌', label: '平静', color: '#73a794', soft: '#e8f3ed' },
    { key: 'tired', emoji: '😴', label: '疲惫', color: '#9b96b5', soft: '#efedf5' },
    { key: 'low', emoji: '😔', label: '低落', color: '#829fb8', soft: '#eaf0f7' },
    { key: 'anxious', emoji: '😰', label: '焦虑', color: '#ce986e', soft: '#fbefe5' },
    { key: 'angry', emoji: '😤', label: '烦躁', color: '#c98179', soft: '#f9eae7' }
  ];
  const TRIGGERS = ['学业', '工作', '人际关系', '家庭', '健康', '睡眠', '金钱', '天气', '自我评价', '其他'];
  const ACTIVITIES = [
    { id: 'breath', title: '跟着呼吸，慢下来', category: '呼吸', duration: 60, symbol: '◌', description: '跟随圆的起伏，吸气 4 秒，呼气 6 秒。按舒服的节奏进行。', subtitle: '1 分钟 · 节奏呼吸' },
    { id: 'ground', title: '回到此时此地', category: '觉察', duration: 60, symbol: '✳', description: '留意周围的颜色、触感和声音，把注意力带回眼前。', subtitle: '1 分钟 · 感官觉察' },
    { id: 'rain', title: '听一会儿雨', category: '声音', duration: 120, symbol: '☂', description: '让轻柔的雨声陪你坐一会儿。开始前请调低音量。', subtitle: '2 分钟 · 雨声放松' },
    { id: 'stretch', title: '给身体一点空间', category: '舒展', duration: 180, symbol: '↗', description: '放下手边的事，轻轻活动肩颈和四肢，按自己的状态来。', subtitle: '3 分钟 · 轻舒展' }
  ];
  const emptyState = () => ({ version: 2, entries: [], sessions: [] });
  const moodByKey = key => MOODS.find(m => m.key === key);
  const activityById = id => ACTIVITIES.find(a => a.id === id);

  function normalizeEntry(e) {
    if (!e || typeof e !== 'object' || !moodByKey(e.mood) || !Number.isInteger(e.intensity) || e.intensity < 1 || e.intensity > 5 || !Number.isFinite(e.ts) || e.ts <= 0 || !Number.isFinite(new Date(e.ts).getTime())) throw Error('记录格式不完整');
    if (!['string', 'number'].includes(typeof e.id) || !String(e.id).length || typeof e.note !== 'string' || e.note.length > 2000 || !Array.isArray(e.triggers) || e.triggers.some(t => typeof t !== 'string' || !t.trim() || t.length > 30)) throw Error('记录内容格式有误');
    return { id: String(e.id), mood: e.mood, intensity: e.intensity, triggers: [...new Set(e.triggers.map(t => t.trim()))], note: e.note, ts: e.ts };
  }

  function normalizeState(value) {
    if (!value || value.version !== 2 || !Array.isArray(value.entries) || !Array.isArray(value.sessions)) throw Error('数据格式无法识别');
    const entries = value.entries.map(normalizeEntry);
    const sessions = value.sessions.map(s => {
      if (!s || typeof s.id !== 'string' || !s.id || !activityById(s.activityId) || !['better', 'same', 'worse', 'skipped'].includes(s.feedback) || !Number.isFinite(s.ts) || s.ts <= 0 || !Number.isFinite(new Date(s.ts).getTime())) throw Error('活动记录格式有误');
      return { id: s.id, activityId: s.activityId, feedback: s.feedback, ts: s.ts, entryId: typeof s.entryId === 'string' ? s.entryId : null };
    });
    if (new Set(entries.map(e => e.id)).size !== entries.length || new Set(sessions.map(s => s.id)).size !== sessions.length) throw Error('记录编号重复');
    return { version: 2, entries: entries.sort((a, b) => b.ts - a.ts), sessions: sessions.sort((a, b) => b.ts - a.ts) };
  }

  function loadState(storage) {
    const backup = {};
    try {
      const current = storage.getItem(KEY);
      if (current !== null) {
        backup[KEY] = current;
        return { state: normalizeState(JSON.parse(current)), error: null, source: 'v2', backup };
      }
      const old = storage.getItem(LEGACY_KEY);
      if (old === null) return { state: emptyState(), error: null, source: 'empty', backup };
      backup[LEGACY_KEY] = old;
      const entries = JSON.parse(old);
      if (!Array.isArray(entries)) throw Error('旧版数据格式无法识别');
      return { state: normalizeState({ version: 2, entries, sessions: [] }), error: null, source: 'v1', backup };
    } catch (error) {
      return { state: emptyState(), error: '暂时无法读取本地日记。原始数据未被覆盖，请先下载备份，再尝试恢复。', source: 'error', backup };
    }
  }

  function saveState(storage, state) {
    try {
      const clean = normalizeState(state);
      storage.setItem(KEY, JSON.stringify(clean));
      return { ok: true, state: clean, error: null };
    } catch (error) {
      return { ok: false, error: '未能保存到浏览器，可能是存储空间不足或权限受限。内容已保留，请重试或先导出备份。' };
    }
  }

  function windowStart(days, now) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - days + 1);
    return date.getTime();
  }

  function analyze(state, days = 7, now = Date.now()) {
    const start = windowStart(days, now);
    const inWindow = row => row.ts >= start && row.ts <= now;
    const entries = state.entries.filter(inWindow).sort((a, b) => b.ts - a.ts);
    const moodCounts = Object.fromEntries(MOODS.map(m => [m.key, 0]));
    const tags = new Map();
    entries.forEach(e => {
      if (moodByKey(e.mood)) moodCounts[e.mood]++;
      [...new Set(e.triggers)].forEach(tag => {
        if (!tags.has(tag)) tags.set(tag, { tag, count: 0, moods: {} });
        const t = tags.get(tag);
        t.count++;
        t.moods[e.mood] = (t.moods[e.mood] || 0) + 1;
      });
    });
    const activityMap = new Map();
    state.sessions.filter(inWindow).forEach(s => {
      if (!activityMap.has(s.activityId)) activityMap.set(s.activityId, { id: s.activityId, completed: 0, rated: 0, better: 0, same: 0, worse: 0 });
      const a = activityMap.get(s.activityId);
      a.completed++;
      if (s.feedback !== 'skipped') { a.rated++; a[s.feedback]++; }
    });
    const daysRecorded = new Set(entries.map(e => new Date(e.ts).toDateString())).size;
    return { entries, total: entries.length, ready: entries.length >= 3, daysRecorded, moodCounts, triggers: [...tags.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh')), activities: [...activityMap.values()] };
  }

  function filterEntries(entries, { query = '', mood = '', trigger = '', start = 0, end = Infinity } = {}) {
    const q = query.trim().toLocaleLowerCase();
    return entries.filter(e => (!mood || e.mood === mood) && (!trigger || e.triggers.includes(trigger)) && e.ts >= start && e.ts <= end && (!q || [e.note, ...e.triggers, moodByKey(e.mood)?.label || ''].join(' ').toLocaleLowerCase().includes(q))).sort((a, b) => b.ts - a.ts);
  }

  function activityProgress(id, elapsedMs) {
    const activity = activityById(id);
    if (!activity) throw Error('未知活动');
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const done = elapsed >= activity.duration * 1000;
    const remaining = Math.max(0, Math.ceil(activity.duration - elapsed / 1000));
    if (id === 'breath') {
      const offset = elapsed % 10000;
      return { done, remaining, fraction: Math.min(1, elapsed / 60000), phase: done ? '完成' : offset < 4000 ? '吸气' : '呼气', phaseSeconds: offset < 4000 ? Math.ceil((4000 - offset) / 1000) : Math.ceil((10000 - offset) / 1000), cycle: Math.min(5, Math.floor(elapsed / 10000) + 1), phaseDuration: offset < 4000 ? 4 : 6 };
    }
    return { done, remaining, fraction: Math.min(1, elapsed / (activity.duration * 1000)), step: Math.min(4, Math.floor(elapsed / (activity.duration * 200))) };
  }

  function createSample(now = Date.now()) {
    const samples = [
      ['anxious', 4, ['工作', '睡眠'], '明天要做汇报，脑子里一直在排练。'],
      ['calm', 2, ['天气'], '午后出去走了一圈，风很舒服。'],
      ['tired', 4, ['工作', '睡眠'], '今天安排太满，想给自己留一点空白。'],
      ['happy', 4, ['人际关系'], '和朋友吃了顿饭，聊了很多小事。'],
      ['anxious', 3, ['工作'], '任务临时调整，有点担心做不完。'],
      ['calm', 3, ['家庭'], '给家里打了电话，心里安稳了一些。'],
      ['low', 3, ['自我评价'], '总在比较进度。今天先做好一件小事。'],
      ['happy', 3, ['工作'], '完成了拖了几天的小任务。'],
      ['tired', 3, ['睡眠'], '昨晚睡得有点晚，今天想早点休息。'],
      ['calm', 2, ['健康'], '给自己做了热乎的晚饭。']
    ];
    return {
      version: 2,
      entries: samples.map((r, i) => ({ id: 'sample-' + i, mood: r[0], intensity: r[1], triggers: r[2].slice(), note: r[3], ts: now - i * 14 * 3600000 })),
      sessions: ['better', 'same', 'better', 'worse', 'skipped'].map((feedback, i) => ({ id: 'sample-care-' + i, activityId: i === 3 ? 'ground' : 'breath', feedback, ts: now - i * 86400000, entryId: null }))
    };
  }

  function recommend(mood, intensity = 3, triggers = []) {
    if (mood === 'tired') return { id: 'stretch', reason: '你提到了疲惫，可以先把注意力放回身体，轻轻活动一下。' };
    if (mood === 'anxious' && intensity >= 4) return { id: 'ground', reason: '此刻的焦虑感比较强，试着先留意眼前的环境。' };
    if (mood === 'low') return { id: 'rain', reason: '给此刻的低落留一点空间，可以听一会儿轻柔的雨声。' };
    if (triggers.includes('睡眠')) return { id: 'rain', reason: '你标记了睡眠，先试一段安静的声音，给自己留个停顿。' };
    if (mood === 'happy' || mood === 'calm') return { id: 'breath', reason: '留一分钟感受此刻，也可以把这份感受写进日记。' };
    return { id: 'breath', reason: mood ? '先给自己一分钟，跟着呼吸慢下来。也可以换一种适合你的方式。' : '不需要先写日记，也可以直接从一个小练习开始。' };
  }

  return { KEY, LEGACY_KEY, MOODS, TRIGGERS, ACTIVITIES, emptyState, moodByKey, activityById, normalizeState, loadState, saveState, windowStart, analyze, filterEntries, activityProgress, createSample, recommend };
});
