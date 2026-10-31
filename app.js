(function () {
  'use strict';
  const C = window.MoodCore;
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const uid = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
  let storage;
  try { storage = window.localStorage; } catch { storage = { getItem() { throw Error('unavailable'); }, setItem() { throw Error('unavailable'); }, removeItem() { throw Error('unavailable'); } }; }
  let loaded = C.loadState(storage);
  let personal = loaded.state;
  let demo = false, sample = null, currentView = 'record', days = 7, selectedMood = null;
  let selectedTriggers = new Set(), editingId = null, historyLimit = 20, triggerFilter = '';
  let activity = null, pendingAudio = null, activityRequest = 0, ticker = null, toastTimer = null, undo = null, savedPersonalDraft = null;
  let lastSaveError = '', writing = false;
  const writeLock = task => navigator.locks ? navigator.locks.request('mood-diary-v2-write', task) : Promise.resolve().then(task);
  const currentState = () => demo ? sample : personal;
  const clockText = seconds => String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');

  function toast(message, allowUndo = false) {
    clearTimeout(toastTimer);
    $('toastMessage').textContent = message;
    $('undoDelete').hidden = !allowUndo;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; if (allowUndo) undo = null; }, allowUndo ? 10000 : 5000);
  }

  async function persist(next) {
    if (demo) { sample = C.normalizeState(next); return true; }
    if (writing) { lastSaveError = '正在保存上一项操作，请稍候再试。'; return false; }
    if (loaded.error) { toast('本地数据暂时无法读取，请先处理页面上方的提示。'); return false; }
    const revision = loaded.revision;
    writing = true;
    let result;
    try { result = await writeLock(() => C.saveState(storage, next, revision)); }
    catch { result = { ok: false, error: '保存暂时不可用，输入已保留，请重试。' }; }
    finally { writing = false; }
    if (!result.ok) {
      if (result.conflict) { loaded = C.loadState(storage); if (!loaded.error) personal = loaded.state; undo = null; renderAll(); }
      lastSaveError = result.error;
      toast(result.error); return false;
    }
    personal = result.state;
    loaded.revision = result.revision;
    return true;
  }

  function switchView(view, focus = false) {
    if (!['record', 'care', 'review'].includes(view)) view = 'record';
    currentView = view;
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== view; });
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === view;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    history.replaceState(null, '', '#' + view);
    if (focus) $('tab-' + view).focus();
    if (view === 'review') renderReview();
  }

  function setupForm() {
    $('moodGrid').innerHTML = C.MOODS.map(m => `<button type="button" class="mood-button" data-mood="${m.key}" aria-pressed="false" style="--mood-color:${m.color};--mood-soft:${m.soft}"><span class="emoji" aria-hidden="true">${m.emoji}</span><span>${m.label}</span></button>`).join('');
    $('triggerGrid').innerHTML = C.TRIGGERS.map(t => `<button type="button" class="trigger-button" data-tag="${t}" aria-pressed="false">${t}</button>`).join('');
    $('historyMood').innerHTML += C.MOODS.map(m => `<option value="${m.key}">${m.emoji} ${m.label}</option>`).join('');
    $('moodGrid').addEventListener('click', event => {
      const button = event.target.closest('[data-mood]');
      if (!button) return;
      selectedMood = button.dataset.mood;
      updateForm(); renderCare();
      $('formError').hidden = true;
    });
    $('triggerGrid').addEventListener('click', event => {
      const button = event.target.closest('[data-tag]');
      if (!button) return;
      const tag = button.dataset.tag;
      if (selectedTriggers.has(tag)) selectedTriggers.delete(tag); else selectedTriggers.add(tag);
      updateForm(); renderCare();
    });
    $('intensity').addEventListener('input', () => { updateForm(); renderCare(); });
    $('note').addEventListener('input', () => { $('noteCount').textContent = $('note').value.length + ' / ' + $('note').maxLength; });
  }

  function updateForm() {
    document.querySelectorAll('[data-mood]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mood === selectedMood)));
    document.querySelectorAll('[data-tag]').forEach(button => button.setAttribute('aria-pressed', String(selectedTriggers.has(button.dataset.tag))));
    $('intensityValue').innerHTML = escape($('intensity').value) + ' <span>/ 5</span>';
    $('intensity').setAttribute('aria-valuetext', '强度 ' + $('intensity').value + '，满分 5');
    $('noteCount').textContent = $('note').value.length + ' / ' + $('note').maxLength;
    $('recordTitle').textContent = editingId ? '修改留给自己的记录' : '此刻，你的感受是？';
    $('saveRecord').innerHTML = editingId ? '保存修改' : '<span aria-hidden="true">＋</span> 保存这一刻';
    $('cancelEdit').hidden = !editingId;
    const messages = {
      happy: ['把这一点开心，留给自己', '开心的原因可以很小。记下这个片刻，日后也许会想回来看看。'],
      calm: ['平静的此刻，也值得记录', '留意一下身体的感受，或者身边的一点小事。安稳也是一种感受。'],
      tired: ['辛苦了，先给自己一点空间', '如果今天的精力有限，可以把步子放慢一点。从一件小事开始就好。'],
      low: ['不想说太多，也没关系', '可以只留下一个表情。现在不用给这份感受找到答案。'],
      anxious: ['先把注意力，放回这一刻', '担心的事情可以慢慢写。也可以先留意眼前的环境，让自己停一停。'],
      angry: ['这份烦躁，可以先放在这里', '不急着回应，也不用马上做决定。先留一点时间给自己。']
    };
    const message = messages[selectedMood] || ['今天，也照顾一下自己', '有些感受还说不清，也没关系。你可以先停一分钟，陪自己待一会儿。'];
    $('companionTitle').textContent = message[0];
    $('companionCopy').textContent = message[1];
  }

  function draft() {
    return { mood: selectedMood, triggers: [...selectedTriggers], intensity: $('intensity').value, note: $('note').value, editingId };
  }

  function restoreDraft(value) {
    selectedMood = value?.mood || null;
    selectedTriggers = new Set(value?.triggers || []);
    editingId = value?.editingId || null;
    $('intensity').value = value?.intensity || 3;
    $('note').value = value?.note || '';
    $('note').maxLength = Math.max(2000, $('note').value.length);
    $('formError').hidden = true;
    updateForm(); renderCare();
  }

  $('journalForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedMood) {
      $('formError').textContent = '先选一个此刻的感受吧，其他内容都可以留空。';
      $('formError').hidden = false;
      $('moodGrid').querySelector('button').focus();
      return;
    }
    const previous = editingId ? currentState().entries.find(e => e.id === editingId) : null;
    if (editingId && !previous) { $('formError').textContent = '这条记录已不存在，请取消编辑后重新记录。'; $('formError').hidden = false; return; }
    const nextEntry = { id: previous?.id || uid(), mood: selectedMood, intensity: Number($('intensity').value), triggers: [...selectedTriggers], note: $('note').value.trim(), ts: previous?.ts || Date.now() };
    const next = { ...currentState(), entries: previous ? currentState().entries.map(e => e.id === previous.id ? nextEntry : e) : [nextEntry, ...currentState().entries] };
    if (!await persist(next)) { $('formError').textContent = lastSaveError || '这次还没有保存成功。输入已保留，请重试，或从数据管理导出现有记录。'; $('formError').hidden = false; return; }
    const edited = !!previous;
    restoreDraft(null);
    renderAll();
    switchView(edited ? 'review' : 'care');
    window.scrollTo({ top: 0, behavior: 'instant' });
    toast(demo ? '已更新示例，个人记录不受影响。' : edited ? '修改已保存。' : '这一刻已保存。接下来，也照顾一下自己。');
  });
  $('cancelEdit').addEventListener('click', () => { restoreDraft(null); switchView('review'); });

  function renderSummary() {
    const state = currentState();
    const today = new Date().toDateString();
    $('todayCount').textContent = state.entries.filter(e => new Date(e.ts).toDateString() === today).length;
    $('allCount').textContent = state.entries.length;
    $('personalSummary').textContent = demo ? '这些示例展示了记录慢慢积累后的样子。' : state.entries.length ? '每一条记录，都是你留给自己的片刻。' : '这里会慢慢收集你的感受。';
  }

  function renderCare() {
    const latest = currentState().entries[0];
    const mood = selectedMood || latest?.mood;
    const intensity = selectedMood ? Number($('intensity').value) : latest?.intensity || 3;
    const triggers = selectedMood ? [...selectedTriggers] : latest?.triggers || [];
    const recommendation = C.recommend(mood, intensity, triggers);
    $('careContext').textContent = selectedMood ? '根据你刚选择的感受' : latest ? '参考最近一次记录 · ' + C.moodByKey(latest.mood).label : '不必先记录，也可以直接开始';
    $('careReason').textContent = recommendation.reason;
    $('activityGrid').innerHTML = C.ACTIVITIES.map(a => `<article class="activity-card ${a.id === recommendation.id ? 'featured' : ''}" data-activity="${a.id}"><div class="activity-card-top"><span class="activity-category">${a.category}</span>${a.id === recommendation.id ? '<span class="recommend-pill">此刻可以试试</span>' : ''}</div><div class="activity-symbol" aria-hidden="true">${a.symbol}</div><h2>${a.title}</h2><p>${a.description}</p><div class="activity-card-bottom"><span class="activity-time">${a.subtitle}</span><button type="button" class="button ${a.id === recommendation.id ? 'primary' : 'secondary'}" data-start="${a.id}" aria-label="开始${a.title}">开始练习 <span aria-hidden="true">↗</span></button></div></article>`).join('');
  }

  const emptyBlock = (title, detail, action = '') => `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">◌</div><p>${title}</p><span>${detail}</span>${action}</div>`;
  function renderReview() {
    const state = currentState(), a = C.analyze(state, days);
    const moodRank = C.MOODS.map(m => ({ ...m, count: a.moodCounts[m.key] })).sort((x, y) => y.count - x.count);
    const maxCount = moodRank[0].count;
    const commonMoods = moodRank.filter(m => m.count === maxCount);
    const common = !a.total ? '—' : commonMoods.length > 1 ? '多种感受' : commonMoods[0].label;
    const completed = a.activities.reduce((n, item) => n + item.completed, 0);
    $('reviewStats').innerHTML = `<div class="stat-card"><div><p class="stat-label">留下的片刻</p><p class="stat-value">${a.total}<small>次记录 · ${a.daysRecorded} 天</small></p></div><span class="stat-icon" aria-hidden="true">✎</span></div><div class="stat-card"><div><p class="stat-label">记录较多的感受</p><p class="stat-value">${common}<small>${a.total ? commonMoods.length > 1 ? '多种感受次数相同' : '出现 ' + maxCount + ' 次' : '等待你的第一条记录'}</small></p></div><span class="stat-icon" aria-hidden="true">◌</span></div><div class="stat-card"><div><p class="stat-label">照顾自己的时间</p><p class="stat-value">${completed}<small>次已完成练习</small></p></div><span class="stat-icon" aria-hidden="true">☘</span></div>`;
    const recent = a.entries.slice(0, 12).reverse();
    $('trendChart').innerHTML = !recent.length ? emptyBlock('感受的变化，会慢慢出现在这里', '记录一次，就留下一个可以回看的片刻。', '<button class="text-button" data-go="record">记录此刻 →</button>') : `<div class="trend-plot"><div class="chart-axis" aria-hidden="true"><span>5</span><span>3</span><span>1</span></div><div class="chart-bars" role="list" aria-label="所选时段最近${recent.length}次感受强度">${recent.map(e => { const m = C.moodByKey(e.mood); const date = new Date(e.ts); const dateText = (date.getMonth() + 1) + '/' + date.getDate(); return `<div class="chart-item" role="listitem" aria-label="${escape(formatDate(e.ts))}，${m.label}，强度${e.intensity}/5" title="${escape(formatDate(e.ts))} · ${m.label} · 强度${e.intensity}/5"><div class="chart-bar" style="height:${e.intensity * 22}px;background:${m.color}"><span>${e.intensity}</span></div><span class="chart-emoji" aria-hidden="true">${m.emoji}</span><time datetime="${date.toISOString()}">${dateText}</time></div>`; }).join('')}</div></div>`;
    $('moodDistribution').innerHTML = `<div class="distribution-list">${C.MOODS.map(m => `<div class="distribution-row"><span aria-hidden="true">${m.emoji}</span><span>${m.label}</span><span class="distribution-rail" role="img" aria-label="${m.label}${a.moodCounts[m.key]}次"><span style="width:${a.total ? a.moodCounts[m.key] / a.total * 100 : 0}%;background:${m.color}"></span></span><span class="distribution-count">${a.moodCounts[m.key]} 次</span></div>`).join('')}</div>`;
    $('triggerInsights').innerHTML = !a.triggers.length ? emptyBlock('还没有留下触发因素', '记录时可以选一两个标签，慢慢发现线索。') : `${!a.ready ? '<p class="insufficient">目前记录较少，先展示标签事实。积累至少 3 条后再一起回顾。</p>' : ''}${a.triggers.slice(0, 3).map(t => { const facts = C.MOODS.filter(m => t.moods[m.key]).map(m => m.label + ' ' + t.moods[m.key] + ' 次').join(' · '); return `<button class="insight-row" data-trigger="${escape(t.tag)}"><div><strong>${escape(t.tag)} <span class="optional">被标记 ${t.count} 次</span></strong><p>${escape(facts)}</p></div><span class="arrow" aria-hidden="true">↗</span></button>`; }).join('')}`;
    $('activityInsights').innerHTML = !a.activities.length ? emptyBlock('还没有完成的关怀练习', '试一个小练习，再记下它带给你的感受。', '<button class="text-button" data-go="care">照顾自己 →</button>') : a.activities.map(row => `<div class="insight-row"><div><strong>${C.activityById(row.id).title}</strong><p>完成 ${row.completed} 次${row.rated ? ' · ' + row.rated + ' 次已反馈' : ' · 暂无感受反馈'}</p><div class="feedback-counts"><span>更轻松 ${row.better}</span><span>差不多 ${row.same}</span><span>更不舒服 ${row.worse}</span></div></div><span class="activity-category">${row.rated ? row.better + '/' + row.rated + ' 更轻松' : '未评价'}</span></div>`).join('');
    renderHistory();
  }

  function formatDate(ts) {
    const date = new Date(ts);
    return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function renderHistory() {
    const useWindow = $('historyPeriod').value === 'window';
    const options = { query: $('historySearch').value, mood: $('historyMood').value, trigger: triggerFilter, start: useWindow ? C.windowStart(days, Date.now()) : 0, end: useWindow ? Date.now() : Infinity };
    const entries = C.filterEntries(currentState().entries, options);
    $('historyCount').textContent = entries.length + ' 条' + (useWindow ? ' · 近 ' + days + ' 天' : ' · 全部时间');
    $('triggerFilter').hidden = !triggerFilter;
    $('triggerFilter').querySelector('span').textContent = '关联因素：' + triggerFilter;
    $('historyList').innerHTML = !entries.length ? emptyBlock(currentState().entries.length ? '没有找到符合条件的日记' : '你的第一条记录，会出现在这里', currentState().entries.length ? '试着换个关键词，或调整筛选条件。' : '不用写很多，一个表情也可以。', currentState().entries.length ? '' : '<button class="text-button" data-go="record">开始记录 →</button>') : entries.slice(0, historyLimit).map(e => {
      const m = C.moodByKey(e.mood), date = new Date(e.ts);
      const day = date.toDateString() === new Date().toDateString() ? '今天' : `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
      const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `<article class="history-entry" data-entry="${escape(e.id)}"><time class="history-date" datetime="${date.toISOString()}" title="${escape(formatDate(e.ts))}">${day}<small>${date.getFullYear()} · ${time}</small></time><div class="history-emoji" style="--entry-soft:${m.soft}" aria-hidden="true">${m.emoji}</div><div class="entry-body"><div class="entry-title">${m.label}<span class="strength-badge">强度 ${e.intensity} / 5</span></div>${e.note ? `<p class="entry-note">${escape(e.note)}</p>` : ''}${e.triggers.length ? `<div class="entry-tags">${e.triggers.map(t => `<span class="entry-tag"># ${escape(t)}</span>`).join('')}</div>` : ''}</div><div class="entry-actions"><button data-action="edit" data-id="${escape(e.id)}" aria-label="编辑${escape(formatDate(e.ts))}的${m.label}记录">编辑</button><button data-action="delete" data-id="${escape(e.id)}" aria-label="删除${escape(formatDate(e.ts))}的${m.label}记录">删除</button></div></article>`;
    }).join('');
    $('loadMore').hidden = entries.length <= historyLimit;
    $('loadMore').textContent = `查看更早的记录（还有 ${Math.max(0, entries.length - historyLimit)} 条）`;
  }

  function renderStorageAlert() {
    $('storageAlert').hidden = !loaded.error || demo;
    $('storageMessage').textContent = loaded.error || '';
    $('backupRaw').disabled = !Object.keys(loaded.backup).length;
  }

  function renderAll() {
    $('sampleBanner').hidden = !demo;
    $('sampleToggle').innerHTML = demo ? '返回我的日记 ↗' : '体验示例 <span aria-hidden="true">↗</span>';
    $('dataModeNote').hidden = !demo;
    $('exportData').disabled = demo || !!loaded.error;
    $('clearData').disabled = demo;
    renderStorageAlert(); renderSummary(); renderCare(); renderReview();
  }

  function toggleSample() {
    if (writing) { toast('正在保存，请稍候再切换模式。'); return; }
    stopActivity();
    undo = null; $('toast').hidden = true;
    if (!demo) { savedPersonalDraft = draft(); sample = C.createSample(); demo = true; restoreDraft(null); }
    else { demo = false; sample = null; restoreDraft(savedPersonalDraft); savedPersonalDraft = null; }
    triggerFilter = ''; historyLimit = 20;
    $('historySearch').value = ''; $('historyMood').value = ''; $('historyPeriod').value = 'all';
    renderAll();
    if (demo) switchView('review');
  }

  $('historyList').addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const row = currentState().entries.find(e => e.id === button.dataset.id);
    if (!row) return;
    if (button.dataset.action === 'edit') {
      restoreDraft({ mood: row.mood, triggers: row.triggers, intensity: row.intensity, note: row.note, editingId: row.id });
      switchView('record'); window.scrollTo({ top: 0, behavior: 'instant' }); $('note').focus({ preventScroll: true });
    } else {
      if (!await persist({ ...currentState(), entries: currentState().entries.filter(e => e.id !== row.id) })) return;
      undo = { row, demo };
      renderAll(); toast(demo ? '已删除一条示例记录。' : '记录已删除，可以撤销。', true);
    }
  });
  $('undoDelete').addEventListener('click', async () => {
    if (!undo || undo.demo !== demo) return;
    if (!currentState().entries.some(e => e.id === undo.row.id) && !await persist({ ...currentState(), entries: [undo.row, ...currentState().entries] })) return;
    undo = null; renderAll(); toast('记录已恢复。');
  });

  function makeRain() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw Error('当前浏览器不支持声音播放，请选择其他练习。');
    const context = new Audio();
    try {
      const buffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
      const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1600;
      const gain = context.createGain(); gain.gain.value = 0.07;
      source.connect(filter); filter.connect(gain); gain.connect(context.destination); source.start();
      return { context, source };
    } catch (error) { context.close().catch(() => {}); throw error; }
  }

  async function startActivity(id, opener) {
    stopActivity();
    const request = activityRequest;
    const config = C.activityById(id);
    if (!config) return;
    let audio = null;
    if (id === 'rain') {
      try { audio = makeRain(); pendingAudio = audio; await audio.context.resume(); }
      catch {
        disposeAudio(audio);
        if (request === activityRequest) { pendingAudio = null; toast('声音暂时无法播放，请检查浏览器音频权限，或选择其他练习。'); }
        return;
      }
      if (request !== activityRequest) { disposeAudio(audio); return; }
      pendingAudio = null;
    }
    activity = { id, base: 0, startedAt: Date.now(), paused: false, done: false, audio, opener, demo, entryId: currentState().entries[0]?.id || null, phase: null };
    $('activityTitle').textContent = config.title;
    $('activityDescription').textContent = config.description;
    $('activePractice').hidden = false; $('feedbackArea').hidden = true; $('feedbackError').hidden = true;
    $('pauseActivity').textContent = '暂停一下';
    $('practiceOrb').classList.toggle('breathing', id === 'breath');
    $('practiceOrb').style.transition = 'none'; $('practiceOrb').style.transform = 'scale(.82)';
    $('orbSymbol').textContent = config.symbol;
    $('activityDialog').showModal();
    tickActivity(); ticker = setInterval(tickActivity, 200);
  }

  function elapsed() { return activity.base + (activity.paused ? 0 : Date.now() - activity.startedAt); }
  const guidance = {
    ground: [
      ['看看身边', '慢慢找到 5 样你看得到的东西，留意它们的颜色。'],
      ['感受接触', '留意衣服、座椅或地面与身体接触的感觉。'],
      ['听一听', '不必寻找特别的声音，只留意此刻听到的声音。'],
      ['感受空气', '留意空气的温度，或者身边熟悉的气味。'],
      ['回到自己', '感受双脚的位置，按舒服的节奏自然呼吸。']
    ],
    rain: [['听见雨落下', '音量保持轻柔，眼睛可以望向一个舒服的地方。'], ['不必做什么', '让声音留在背景里，不用努力清空思绪。'], ['留意身体', '感受肩膀、手掌和座椅的接触。'], ['让念头经过', '想到什么也没关系，再慢慢回到声音。'], ['留一点安静', '这段时间只属于你，照自己的节奏来。']],
    stretch: [['先找到舒服的位置', '站着或坐着都可以，动作幅度以舒服为准。'], ['松一松肩膀', '轻轻抬起肩膀，再慢慢放下。'], ['活动手掌', '张开手指，再轻轻放松，留意手掌的感觉。'], ['伸展一下身体', '在舒服的范围内伸个懒腰，也可以原地走几步。'], ['慢慢回到当下', '停下来感受身体。不舒服时就结束练习。']]
  };

  function tickActivity() {
    if (!activity || activity.paused || activity.done) return;
    const progress = C.activityProgress(activity.id, elapsed());
    $('activityClock').textContent = clockText(progress.remaining);
    $('activityProgress').style.width = progress.fraction * 100 + '%';
    if (progress.done) {
      activity.done = true;
      clearInterval(ticker); ticker = null;
      closeAudio();
      $('activePractice').hidden = true; $('feedbackArea').hidden = false;
      $('feedbackArea').querySelector('button').focus();
      return;
    }
    if (activity.id === 'breath') {
      $('phaseHint').textContent = `第 ${progress.cycle} / ${progress.totalCycles} 轮 · ${progress.phase}还剩 ${progress.phaseSeconds} 秒`;
      const stage = progress.cycle + progress.phase;
      if (activity.phase !== stage) {
        activity.phase = stage;
        $('phaseText').textContent = progress.phase;
        $('practiceOrb').style.transition = `transform ${progress.phaseRemainingMs / 1000}s ease-in-out`;
        // Start the expansion after the dialog's first layout.
        requestAnimationFrame(() => { if (activity && !activity.paused) $('practiceOrb').style.transform = progress.phase === '吸气' ? 'scale(1.18)' : 'scale(.82)'; });
      }
    } else {
      const text = guidance[activity.id][progress.step];
      $('phaseText').textContent = text[0]; $('phaseHint').textContent = text[1];
      $('practiceOrb').style.transform = 'scale(1)';
    }
  }

  function disposeAudio(audio) {
    if (!audio) return;
    try { audio.source.stop(); } catch {}
    if (audio.context.state !== 'closed') audio.context.close().catch(() => {});
  }

  function closeAudio() {
    if (activity?.audio) { disposeAudio(activity.audio); activity.audio = null; }
  }

  function stopActivity() {
    activityRequest++;
    disposeAudio(pendingAudio); pendingAudio = null;
    clearInterval(ticker); ticker = null;
    const opener = activity?.opener;
    closeAudio(); activity = null;
    if ($('activityDialog').open) $('activityDialog').close();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  $('pauseActivity').addEventListener('click', () => {
    if (!activity || activity.done) return;
    if (!activity.paused) {
      activity.base = elapsed(); activity.paused = true;
      const transform = getComputedStyle($('practiceOrb')).transform;
      $('practiceOrb').style.transition = 'none'; $('practiceOrb').style.transform = transform;
      activity.audio?.context.suspend().catch(() => {});
      $('pauseActivity').textContent = '继续练习'; $('phaseText').textContent = '暂停一下，也很好';
    } else {
      activity.paused = false; activity.startedAt = Date.now(); activity.phase = null;
      activity.audio?.context.resume().catch(() => toast('声音未恢复，可以结束后重新开始。'));
      $('pauseActivity').textContent = '暂停一下'; tickActivity();
    }
  });
  $('endActivity').addEventListener('click', stopActivity);
  $('activityDialog').addEventListener('cancel', event => { event.preventDefault(); stopActivity(); });
  $('activityDialog').addEventListener('click', async event => {
    const button = event.target.closest('[data-feedback]');
    if (!button || !activity?.done || activity.demo !== demo) return;
    const session = { id: uid(), activityId: activity.id, feedback: button.dataset.feedback, ts: Date.now(), entryId: activity.entryId };
    if (!await persist({ ...currentState(), sessions: [session, ...currentState().sessions] })) { $('feedbackError').textContent = lastSaveError || '反馈还没有保存成功，请重试。也可以关闭，暂时不保存。'; $('feedbackError').hidden = false; return; }
    const worse = session.feedback === 'worse';
    stopActivity(); renderAll();
    toast(worse ? '感受已记下。先停一停，不必继续这项练习。' : demo ? '示例反馈已记录，个人数据不受影响。' : '这段照顾自己的时间，已为你记下。');
  });
  window.addEventListener('pagehide', stopActivity);

  function download(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function openData() { renderAll(); $('dataDialog').showModal(); }
  $('dataButton').addEventListener('click', openData); $('footerData').addEventListener('click', openData);
  $('closeData').addEventListener('click', () => $('dataDialog').close());
  $('exportData').addEventListener('click', () => {
    if (demo || loaded.error) return;
    download({ app: '心晴日记', exportedAt: new Date().toISOString(), ...personal }, '心晴日记-备份-' + new Date().toLocaleDateString('sv-SE') + '.json');
    toast('备份已生成，请妥善保存下载的文件。');
  });
  async function clearPersonal(recovery = false) {
    if (demo || writing) return;
    if (!confirm(recovery ? '确认重置本地数据？请先下载原始备份。重置会删除当前版本与旧版记录。' : '确认清空全部日记和活动反馈？旧版备份也将删除。请先导出备份，此操作不能撤销。')) return;
    try {
      // Remove legacy first: interrupted cleanup must never resurrect old records.
      await writeLock(() => { storage.removeItem(C.LEGACY_KEY); storage.removeItem(C.KEY); });
      loaded = C.loadState(storage);
      if (loaded.error) throw Error('storage blocked');
      personal = loaded.state; undo = null;
      restoreDraft(null); renderAll();
      if ($('dataDialog').open) $('dataDialog').close();
      toast('本地日记和活动反馈已清空。');
    } catch {
      loaded = C.loadState(storage); personal = loaded.state; renderAll();
      toast('未能完整清空，请检查浏览器存储权限后重试。');
    }
  }
  $('clearData').addEventListener('click', () => clearPersonal(false));
  $('resetStorage').addEventListener('click', () => clearPersonal(true));
  $('backupRaw').addEventListener('click', () => download({ app: '心晴日记原始备份', raw: loaded.backup }, '心晴日记-原始备份.json'));
  $('retryLoad').addEventListener('click', () => {
    loaded = C.loadState(storage);
    if (!loaded.error) personal = loaded.state;
    renderAll(); toast(loaded.error ? '仍然无法读取，请先下载原始备份。' : '已重新读取本地日记。');
  });

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-view],[data-go],[data-start],[data-trigger]');
    if (!button) return;
    if (button.dataset.view || button.dataset.go) switchView(button.dataset.view || button.dataset.go);
    else if (button.dataset.start) startActivity(button.dataset.start, button);
    else if (button.dataset.trigger) {
      triggerFilter = button.dataset.trigger; historyLimit = 20;
      $('historySearch').value = ''; $('historyMood').value = ''; $('historyPeriod').value = 'window'; renderHistory();
      $('historyList').scrollIntoView({ behavior: 'instant', block: 'start' });
      $('clearTrigger').focus({ preventScroll: true });
    }
  });
  document.querySelector('.main-nav').addEventListener('keydown', event => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const views = ['record', 'care', 'review']; let index = views.indexOf(currentView);
    index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    event.preventDefault(); switchView(views[index], true);
  });
  document.querySelectorAll('[data-days]').forEach(button => button.addEventListener('click', () => {
    days = Number(button.dataset.days);
    document.querySelectorAll('[data-days]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    historyLimit = 20; renderReview();
  }));
  $('sampleToggle').addEventListener('click', toggleSample); $('exitSample').addEventListener('click', toggleSample);
  ['historySearch', 'historyMood', 'historyPeriod'].forEach(id => $(id).addEventListener(id === 'historySearch' ? 'input' : 'change', () => { historyLimit = 20; renderHistory(); }));
  $('clearTrigger').addEventListener('click', () => { triggerFilter = ''; historyLimit = 20; renderHistory(); });
  $('loadMore').addEventListener('click', () => { historyLimit += 20; renderHistory(); });
  window.addEventListener('hashchange', () => switchView(location.hash.slice(1)));
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== C.KEY && event.key !== C.LEGACY_KEY) return;
    loaded = C.loadState(storage);
    if (!loaded.error) personal = loaded.state;
    undo = null;
    renderAll();
    if (!demo) toast('另一个页面更新了日记，已同步。当前输入仍然保留。');
  });
  setupForm(); updateForm(); renderAll();
  $('todayLabel').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) + ' / A LITTLE CHECK-IN';
  switchView(location.hash.slice(1));
})();
