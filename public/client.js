'use strict';
const socket = io();
window.gameSocket = socket;
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
let playerId = store.get('pokerPid') || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
store.set('pokerPid', playerId);
window.getPlayerId = () => playerId;

const $ = id => document.getElementById(id);
let myState = null, mySeat = 0, currentRoom = '';

// 渲染间的状态差异追踪
let firstRender = true;
let prev = { handId: 0, communityLen: 0, log: [], phase: 'waiting', myTurn: false };

// ================= 大厅 =================
$('nameInput').value = store.get('pokerName') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('roomInput').value = urlRoom.toUpperCase();
$('genRoom').onclick = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  $('roomInput').value = c; Sfx.play('click');
};
$('joinBtn').onclick = doJoin;
$('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
function doJoin() {
  Sfx.resume();
  const name = $('nameInput').value.trim();
  const room = $('roomInput').value.trim().toUpperCase();
  if (!name) return hint('请输入昵称');
  if (!room) return hint('请输入房间号');
  store.set('pokerName', name);
  socket.emit('join', { room, name, playerId }, res => {
    if (!res || !res.ok) return hint(res ? res.error : '加入失败');
    playerId = res.playerId; store.set('pokerPid', playerId);
    currentRoom = res.room;
    $('roomCode').textContent = res.room;
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    history.replaceState(null, '', '?room=' + res.room);
  });
}
function hint(t) { $('lobbyHint').textContent = t; }

// ================= 顶栏 =================
$('leaveBtn').onclick = () => { socket.emit('leave'); location.href = location.pathname; };
$('copyLink').onclick = () => {
  const url = location.origin + location.pathname + '?room=' + currentRoom;
  navigator.clipboard?.writeText(url).then(() => toast('邀请链接已复制')).catch(() => toast(url));
};
function refreshSoundBtn() { $('soundBtn').textContent = Sfx.isEnabled() ? '🔊' : '🔇'; }
$('soundBtn').onclick = () => { Sfx.setEnabled(!Sfx.isEnabled()); refreshSoundBtn(); if (Sfx.isEnabled()) Sfx.play('click'); };
refreshSoundBtn();

// ================= 卡牌 =================
const SUITS = ['♠', '♥', '♣', '♦'];
const POS_CN = { SB:'小盲位', BB:'大盲位', UTG:'枪口位', EP:'早期位', MP:'中期位', CO:'关煞位', BTN:'庄家位' };
const RED = { 1: true, 3: true };
function rankLabel(r) { return r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : r === 10 ? '10' : String(r); }
function cardEl(card, opts = {}) {
  const d = document.createElement('div');
  d.className = 'card' + (opts.small ? ' small' : '') + (opts.win ? ' hlwin' : '');
  if (opts.dealt) d.classList.add('dealt');
  if (opts.flip) d.classList.add('flip');
  if (opts.delay) d.style.animationDelay = opts.delay + 'ms';
  if (!card || card.hidden) { d.classList.add('back'); return d; }
  if (RED[card.suit]) d.classList.add('red');
  const s = SUITS[card.suit], r = rankLabel(card.rank);
  d.innerHTML = `<span class="idx"><b>${r}</b><i>${s}</i></span><span class="big">${s}</span>`;
  return d;
}
function cardKey(c) { return c ? c.rank + '-' + c.suit : ''; }

// 头像颜色（按名字散列）
const AV_COLORS = ['#5b8def','#e0754a','#37a06a','#b45cd0','#d8a637','#3aa8b0','#d0506e','#7a6cf0'];
function avatarFor(name) {
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { color: AV_COLORS[h % AV_COLORS.length], letter: (name[0] || '?').toUpperCase() };
}

// 座位布局（本人固定下方）
const SLOTS = [
  { left: '50%', top: '99%' }, { left: '8%', top: '80%' }, { left: '8%', top: '20%' },
  { left: '50%', top: '1%' }, { left: '92%', top: '20%' }, { left: '92%', top: '80%' },
];

function render(state) {
  myState = state;
  const me = state.players.find(p => p && p.id === playerId);
  mySeat = me ? me.seat : 0;

  const phaseMap = { waiting: '等待开始', preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈', showdown: '摊牌结算' };
  $('phaseLabel').textContent = phaseMap[state.phase] || state.phase;

  const isNewHand = state.handId !== prev.handId && state.phase === 'preflop';
  const newCommCards = Math.max(0, state.community.length - prev.communityLen);

  // 公共牌
  const comm = $('community'); comm.innerHTML = '';
  const winCards = new Set();
  if (state.lastResult && state.lastResult.showdown)
    for (const h of state.lastResult.hands) for (const c of h.best) winCards.add(cardKey(c));
  state.community.forEach((c, i) => {
    const isNew = i >= state.community.length - newCommCards;
    comm.appendChild(cardEl(c, { win: winCards.has(cardKey(c)), flip: isNew, delay: isNew ? (i - (state.community.length - newCommCards)) * 120 : 0 }));
  });

  // 底池
  $('potText').textContent = '底池 ' + state.pot;

  // 结算文字
  const resEl = $('result'); resEl.innerHTML = '';
  if (state.lastResult) {
    const parts = state.lastResult.pots.map(pot => pot.winners.map(w => `${w.name} +${w.share}`).join('、'));
    let txt = '🏆 <span class="big">' + parts.join(' | ') + '</span>';
    if (state.lastResult.showdown) {
      const hd = state.lastResult.hands.map(h => `${h.name}:${h.handName}`).join('　');
      txt += '<br>' + hd;
    }
    resEl.innerHTML = txt;
  }

  // 座位
  const seatsEl = $('seats'); seatsEl.innerHTML = '';
  let dealIdx = 0;
  for (let i = 0; i < state.maxSeats; i++) {
    const actual = (mySeat + i) % state.maxSeats;
    const p = state.players[actual];
    const slot = SLOTS[i];
    const seat = document.createElement('div');
    seat.className = 'seat'; seat.style.left = slot.left; seat.style.top = slot.top;
    if (!p) { seat.classList.add('empty'); seat.innerHTML = '<div class="plate"><div class="pname">空位</div></div>'; seatsEl.appendChild(seat); continue; }
    seat.dataset.pid = p.id;
    if (p.isTurn) seat.classList.add('turn');
    if (state.phase !== 'showdown' && state.phase !== 'waiting' && !p.inHand) seat.classList.add('folded');
    const isWinner = state.lastResult && state.lastResult.pots.some(pot => pot.winners.some(w => w.id === p.id));
    if (isWinner && state.phase === 'showdown') seat.classList.add('winner');

    const av = avatarFor(p.name);
    const plate = document.createElement('div'); plate.className = 'plate';
    plate.innerHTML =
      (p.bet > 0 ? `<div class="bet"><span class="cc"></span>${p.bet}</div>` : '') +
      (p.isDealer ? '<div class="dealer-btn">D</div>' : '') +
      (p.position ? `<div class="pos-pill ${p.position}" title="${POS_CN[p.position] || ''}">${p.position}</div>` : '') +
      `<div class="head"><div class="avatar" style="background:${av.color}">${av.letter}</div>
        <div class="who"><div class="pname">${escapeHtml(p.name)}${isWinner && state.phase==='showdown' ? ' 🏆' : ''}</div>
        <div class="pstack">🪙 ${p.stack}</div></div></div>`;
    // 底牌
    const cards = document.createElement('div'); cards.className = 'pcards';
    if (p.hole && p.hole.length) {
      let best = new Set();
      if (state.lastResult && state.lastResult.showdown) {
        const h = state.lastResult.hands.find(x => x.id === p.id);
        if (h) for (const c of h.best) best.add(cardKey(c));
      }
      p.hole.forEach(c => cards.appendChild(cardEl(c, { small: true, win: best.has(cardKey(c)), dealt: isNewHand, delay: isNewHand ? (dealIdx++) * 90 : 0 })));
    }
    plate.appendChild(cards);
    // 标签
    let tags = '';
    if (p.allIn) tags += '<span class="tag allin">全下</span>';
    if (p.sittingOut) tags += '<span class="tag off">暂离</span>';
    if (!p.connected) tags += '<span class="tag out disc">断线</span>';
    if (p.isBot) tags += '<span class="tag bot">🤖</span>';
    if (p.id === playerId) tags += '<span class="tag me">你</span>';
    if (tags) { const t = document.createElement('div'); t.innerHTML = tags; plate.appendChild(t); }
    seat.appendChild(plate);
    seatsEl.appendChild(seat);
  }

  renderControls(state, me);
  updateResetBtn(state);
  updateBotBtns(state);
  if (window.applyVoiceUI) window.applyVoiceUI();

  // ---- 事件联动（音效 / 动画）----
  if (!firstRender) {
    // 底池跳动
    if (state.pot !== prev.pot) $('pot').classList.remove('bump'), void $('pot').offsetWidth, $('pot').classList.add('bump');
    // 日志差异 -> 音效 + 飞行筹码
    const fresh = newLogLines(prev.log, state.log);
    processLogEvents(fresh, state);
    // 轮到你
    const myTurn = !!state.actions;
    if (myTurn && !prev.myTurn) { Sfx.play('turn'); if (navigator.vibrate) try { navigator.vibrate(60); } catch {} }
    // 摊牌 -> 获胜特效
    if (state.phase === 'showdown' && prev.phase !== 'showdown' && state.lastResult) winEffects(state);
  } else {
    firstRender = false;
  }

  prev = { handId: state.handId, communityLen: state.community.length, log: state.log.slice(), phase: state.phase, myTurn: !!state.actions, pot: state.pot };
}

function renderControls(state, me) {
  const waiting = $('waitingControls'), action = $('actionControls'), banner = $('turnBanner');
  waiting.classList.add('hidden'); action.classList.add('hidden'); banner.textContent = '';

  if (state.canStart) {
    waiting.classList.remove('hidden');
    const enough = state.eligibleCount >= 2;
    $('startBtn').disabled = !enough;
    $('waitHint').textContent = enough ? (state.phase === 'showdown' ? '本局结束，可开始下一局' : '人齐了，点开始发牌') : '至少需要 2 名有筹码的玩家';
  } else if (state.actions) {
    banner.textContent = '🎯 轮到你了！';
    action.classList.remove('hidden');
    const a = state.actions, btn = sel => action.querySelector(`.act.${sel}`);
    btn('check').disabled = !a.canCheck;
    const cb = btn('call'); cb.disabled = !a.canCall; cb.textContent = a.canCall ? `跟注 ${a.callAmount}` : '跟注';
    btn('allin').disabled = !a.canAllIn; btn('allin').textContent = `全下 ${a.stack}`;
    const slider = $('raiseSlider'), rb = btn('raise');
    if (a.canRaise && a.maxRaiseTo > a.minRaiseTo) {
      slider.disabled = false; rb.disabled = false;
      slider.min = a.minRaiseTo; slider.max = a.maxRaiseTo; slider.step = state.bigBlind;
      if (+slider.value < a.minRaiseTo || +slider.value > a.maxRaiseTo) slider.value = a.minRaiseTo;
      $('raiseAmt').textContent = '加注至 ' + slider.value;
      slider.oninput = () => { $('raiseAmt').textContent = '加注至 ' + slider.value; };
    } else if (a.canRaise && a.maxRaiseTo === a.minRaiseTo) {
      slider.disabled = true; rb.disabled = false; slider.value = a.maxRaiseTo; $('raiseAmt').textContent = '加注至 ' + a.maxRaiseTo;
    } else { slider.disabled = true; rb.disabled = true; $('raiseAmt').textContent = '—'; }
  } else {
    // 等待他人
    const p = state.players[state.currentTurn];
    if (p && state.phase !== 'waiting' && state.phase !== 'showdown') banner.textContent = '等待 ' + p.name + ' 行动…';
  }
}

function updateBotBtns(state) {
  const seated = state.players.filter(Boolean);
  const full = seated.length >= state.maxSeats;
  const botCount = seated.filter(p => p.isBot).length;
  const add = $('addBotBtn'), rm = $('removeBotBtn');
  if (add) add.disabled = full;
  if (rm) { rm.disabled = botCount === 0; rm.textContent = botCount ? `− 机器人(${botCount})` : '− 机器人'; }
}

function updateResetBtn(state) {
  const b = $('resetBtn'); if (!b || !state.reset) return;
  const r = state.reset;
  b.disabled = !r.available;
  b.classList.toggle('voted', r.mine);
  if (r.mine) b.textContent = `已同意重置 ${r.count}/${r.total}·取消`;
  else b.textContent = r.count > 0 ? `同意重置 ${r.count}/${r.total}` : '重置筹码·重开对局';
  b.title = r.total ? ('同意重开的玩家：' + (r.voters.join('、') || '暂无') + '（需全体同意）') : '';
}

// 滚动日志的增量（日志是最近 N 条的滚动窗口）
function newLogLines(prevLog, nextLog) {
  for (let shift = 0; shift <= prevLog.length; shift++) {
    const overlap = prevLog.slice(shift);
    let eq = true;
    for (let i = 0; i < overlap.length; i++) if (overlap[i] !== nextLog[i]) { eq = false; break; }
    if (eq) return nextLog.slice(overlap.length);
  }
  return nextLog;
}

function processLogEvents(lines, state) {
  const names = state.players.filter(Boolean).map(p => p.name).sort((a, b) => b.length - a.length);
  for (const line of lines) {
    // 音效
    if (line.includes('重开对局')) { Sfx.play('chips'); toast('筹码已重置为 10000，可开始新对局'); }
    else if (line.includes('局开始')) Sfx.play('deal');
    else if (line.includes('翻牌') || line.includes('转牌') || line.includes('河牌')) Sfx.play('flip');
    else if (line.includes('弃牌')) Sfx.play('fold');
    else if (line.includes('看牌')) Sfx.play('check');
    else if (line.includes('全下')) Sfx.play('allin');
    else if (line.includes('加注')) Sfx.play('raise');
    else if (line.includes('跟注') || line.includes('下小盲') || line.includes('下大盲')) Sfx.play('chip');
    // 飞行筹码：有投入的动作，从该玩家飞向底池
    if (/(跟注|加注|全下|下小盲|下大盲)/.test(line)) {
      const nm = names.find(n => line.startsWith(n));
      if (nm) flyChipFromPlayer(nm);
    }
  }
}

function seatRectByName(name) {
  const p = (myState.players.find(x => x && x.name === name));
  if (!p) return null;
  const el = document.querySelector(`.seat[data-pid="${cssEsc(p.id)}"] .plate`);
  return el ? el.getBoundingClientRect() : null;
}
function flyChipFromPlayer(name) {
  const from = seatRectByName(name); const potEl = $('pot');
  if (!from || !potEl) return;
  flyChip(from, potEl.getBoundingClientRect());
}
function flyChip(fromRect, toRect, delay = 0) {
  const fx = $('fx'); if (!fx) return;
  const c = document.createElement('div'); c.className = 'fly-chip';
  const sx = fromRect.left + fromRect.width / 2, sy = fromRect.top + fromRect.height / 2;
  const ex = toRect.left + toRect.width / 2, ey = toRect.top + toRect.height / 2;
  fx.appendChild(c);
  const anim = c.animate([
    { left: sx + 'px', top: sy + 'px', opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
    { left: ex + 'px', top: ey + 'px', opacity: .95, offset: .82, transform: 'translate(-50%,-50%) scale(1)' },
    { left: ex + 'px', top: ey + 'px', opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' },
  ], { duration: 520, delay, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' });
  anim.onfinish = () => c.remove();
}

function winEffects(state) {
  Sfx.play('win');
  confettiBurst();
  // 底池筹码飞向赢家
  const potRect = $('pot').getBoundingClientRect();
  const winners = new Set();
  for (const pot of state.lastResult.pots) for (const w of pot.winners) winners.add(w.id);
  let d = 0;
  winners.forEach(id => {
    const el = document.querySelector(`.seat[data-pid="${cssEsc(id)}"] .plate`);
    if (el) for (let k = 0; k < 3; k++) flyChip(potRect, el.getBoundingClientRect(), 200 + d * 60 + k * 90);
    d++;
  });
  setTimeout(() => Sfx.play('chips'), 250);
}

// ================= 彩带 =================
function confettiBurst() {
  const cv = $('confetti'); if (!cv) return;
  const ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const colors = ['#f0ce74', '#4db2ff', '#37c07a', '#e8574b', '#ffffff', '#c9822a'];
  const parts = [];
  for (let i = 0; i < 140; i++) parts.push({
    x: innerWidth / 2 + (Math.random() - .5) * 120, y: innerHeight * 0.32,
    vx: (Math.random() - .5) * 15, vy: Math.random() * -13 - 3, g: .42,
    col: colors[i % colors.length], r: 3 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - .5) * .5,
  });
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, cv.width, cv.height); frame++;
    let alive = false;
    for (const p of parts) {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      if (p.y < cv.height + 30) alive = true;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.col;
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
    }
    if (alive && frame < 170) requestAnimationFrame(tick); else ctx.clearRect(0, 0, cv.width, cv.height);
  })();
}

// ================= 操作按钮 =================
$('startBtn').onclick = () => { Sfx.play('click'); socket.emit('start'); };
$('actionControls').querySelectorAll('.act').forEach(b => {
  b.onclick = () => {
    const act = b.dataset.act;
    Sfx.play('click');
    if (act === 'raise') socket.emit('action', { type: 'raise', amount: +$('raiseSlider').value });
    else socket.emit('action', { type: act });
  };
});
$('sitOutBtn').onclick = () => { const me = myState && myState.players.find(p => p && p.id === playerId); socket.emit('sitOut', !(me && me.sittingOut)); };
$('addBotBtn').onclick = () => { Sfx.play('click'); socket.emit('addBot'); };
$('removeBotBtn').onclick = () => { Sfx.play('click'); socket.emit('removeBot'); };
$('resetBtn').onclick = () => { Sfx.play('click'); socket.emit('resetVote'); };

// ================= 聊天 =================
$('sendBtn').onclick = sendChat;
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() { const t = $('chatInput').value.trim(); if (!t) return; socket.emit('chat', t); $('chatInput').value = ''; }
let prevChatLen = 0;
socket.on('chat', msgs => {
  const box = $('messages'); box.innerHTML = '';
  for (const m of msgs) {
    const d = document.createElement('div');
    if (m.sys) { d.className = 'msg sys'; d.textContent = m.text; }
    else { d.className = 'msg'; d.innerHTML = `<span class="who">${escapeHtml(m.name)}</span>${escapeHtml(m.text)}`; }
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
  if (msgs.length > prevChatLen && prevChatLen > 0) { const last = msgs[msgs.length - 1]; if (!last.sys) Sfx.play('click'); }
  prevChatLen = msgs.length;
});

// ================= 标签页 =================
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const tab = t.dataset.tab;
    $('chatPanel').classList.toggle('hidden', tab !== 'chat');
    $('logPanel').classList.toggle('hidden', tab !== 'log');
  };
});

// ================= 状态 & 提示 =================
socket.on('state', state => {
  render(state);
  const log = $('logList'); log.innerHTML = '';
  for (const line of state.log) {
    const d = document.createElement('div');
    d.className = 'log-item' + (line.includes('赢得') || line.includes('底池') ? ' hl' : '');
    d.textContent = line; log.appendChild(d);
  }
  log.scrollTop = log.scrollHeight;
});
socket.on('notice', msg => toast(msg));
socket.on('connect', () => { if (currentRoom) { firstRender = true; socket.emit('join', { room: currentRoom, name: store.get('pokerName'), playerId }, () => {}); } });

let toastTimer;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2200); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
