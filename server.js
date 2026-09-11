'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table } = require('./src/table');
const Bot = require('./src/bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

// 房间：code -> { table, chat[], players: Map(playerId -> {socketId, name}), createdAt }
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      table: new Table({ maxSeats: 6, smallBlind: 50, bigBlind: 100, startingStack: 10000 }),
      chat: [],
      players: new Map(),
      voice: new Set(), // 已开麦的 playerId
      createdAt: Date.now(),
    });
  }
  return rooms.get(code);
}

function broadcastState(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const [pid, info] of room.players) {
    if (!info.socketId) continue;
    io.to(info.socketId).emit('state', room.table.getStateFor(pid));
  }
}

function broadcastChat(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('chat', room.chat.slice(-50));
}

const BOT_NAMES = ['小智', '阿尔法', '老练哥', '稳如山', '幸运星', '莽夫', '冷面', '赌圣'];
function pickBotName(table) {
  const used = new Set(table.activePlayers().map(p => p.name));
  const free = BOT_NAMES.filter(n => !used.has(n));
  const base = free.length ? free[Math.floor(Math.random() * free.length)] : '机器人';
  let name = base, i = 2;
  while (used.has(name)) name = base + i++;
  return name;
}

// 轮到机器人时，延时自动行动；打完一个再排下一个
function maybeDriveBots(code) {
  const r = rooms.get(code);
  if (!r || r._botTimer) return;
  const t = r.table;
  if (t.phase === 'waiting' || t.phase === 'showdown') return;
  const cur = t.seats[t.currentTurn];
  if (!cur || !cur.isBot || cur.allIn || !cur.inHand) return;
  r._botTimer = setTimeout(() => {
    r._botTimer = null;
    const b = t.seats[t.currentTurn];
    if (t.phase !== 'waiting' && t.phase !== 'showdown' && b && b.isBot && b.inHand && !b.allIn) {
      let done = false;
      try {
        const mv = Bot.decide(t, b.id);
        const res = t.act(b.id, mv.type, mv.amount);
        done = res.ok;
      } catch (e) { done = false; }
      if (!done) { // 兜底：合法的看牌或弃牌
        const toCall = t.currentBet - b.bet;
        t.act(b.id, toCall > 0 ? 'fold' : 'check');
      }
      broadcastState(code);
    }
    maybeDriveBots(code);
  }, 700 + Math.random() * 900);
}

function emitToPlayer(room, pid, event, payload) {
  const info = room.players.get(pid);
  if (info && info.socketId) io.to(info.socketId).emit(event, payload);
}
function broadcastVoice(code) {
  const r = rooms.get(code);
  if (!r) return;
  io.to(code).emit('voice-state', { peers: [...(r.voice || [])] });
}

function sanitizeName(n) {
  n = String(n || '').trim().slice(0, 16);
  return n || '玩家';
}
function sanitizeRoom(c) {
  c = String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c;
}

io.on('connection', (socket) => {
  let joinedRoom = null;
  let playerId = null;

  socket.on('join', ({ room, name, playerId: pid }, cb) => {
    room = sanitizeRoom(room);
    name = sanitizeName(name);
    if (!room) return cb && cb({ ok: false, error: '房间号无效' });
    pid = String(pid || '').slice(0, 40) || (socket.id);

    const r = getRoom(room);
    // 已存在同 playerId -> 重连；否则加入座位
    let seatRes;
    if (r.table.findSeat(pid) !== -1) {
      seatRes = { ok: true };
      const p = r.table.player(pid);
      if (p) { p.name = name; p.connected = true; }
    } else {
      seatRes = r.table.addPlayer(pid, name);
      if (!seatRes.ok) return cb && cb({ ok: false, error: seatRes.error });
    }

    r.players.set(pid, { socketId: socket.id, name });
    r.table.setConnected(pid, true);
    joinedRoom = room;
    playerId = pid;
    socket.join(room);

    r.chat.push({ sys: true, text: `${name} 进入房间`, t: Date.now() });
    cb && cb({ ok: true, playerId: pid, room });
    broadcastState(room);
    broadcastChat(room);
    broadcastVoice(room);
  });

  socket.on('start', () => {
    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    const res = r.table.startHand();
    if (!res.ok) {
      socket.emit('notice', res.error);
      return;
    }
    broadcastState(joinedRoom);
    maybeDriveBots(joinedRoom);
  });

  socket.on('addBot', () => {
    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    if (r.table.activePlayers().length >= r.table.maxSeats) { socket.emit('notice', '牌桌已满'); return; }
    const name = pickBotName(r.table);
    const id = r.table.addBot(name);
    if (id) {
      r.chat.push({ sys: true, text: `机器人 ${name} 加入了牌桌`, t: Date.now() });
      broadcastState(joinedRoom); broadcastChat(joinedRoom);
    }
  });

  socket.on('removeBot', () => {
    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    const bots = r.table.bots();
    if (!bots.length) { socket.emit('notice', '没有机器人可移除'); return; }
    // 优先移除：已输光的 > 当前不在牌局中的 > 都在牌局中则等这局结束
    const b = bots.find(x => x.stack <= 0) || bots.find(x => !x.inHand);
    if (!b) { socket.emit('notice', '机器人都在这局牌里，等这局结束再移除'); return; }
    const nm = b.name;
    r.table.removePlayer(b.id);
    r.chat.push({ sys: true, text: `机器人 ${nm} 离开了牌桌`, t: Date.now() });
    broadcastState(joinedRoom); broadcastChat(joinedRoom);
    maybeDriveBots(joinedRoom);
  });

  socket.on('action', ({ type, amount }) => {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    const res = r.table.act(playerId, type, amount);
    if (!res.ok) { socket.emit('notice', res.error); return; }
    broadcastState(joinedRoom);
    maybeDriveBots(joinedRoom);
  });

  socket.on('sitOut', (val) => {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    r.table.toggleSitOut(playerId, val);
    broadcastState(joinedRoom);
  });

  socket.on('resetVote', () => {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    const before = r.table.handId;
    const res = r.table.voteReset(playerId);
    if (!res.ok) { socket.emit('notice', res.error); return; }
    const p = r.table.player(playerId);
    const info = r.table.resetInfo(playerId);
    if (info.count === info.total) {
      r.chat.push({ sys: true, text: '全体同意，已重开对局，每人筹码重置为 ' + r.table.startingStack, t: Date.now() });
      broadcastChat(joinedRoom);
    } else if (p) {
      const act = info.mine ? '发起/同意' : '取消了';
      r.chat.push({ sys: true, text: `${p.name} ${act}重置筹码（${info.count}/${info.total}）`, t: Date.now() });
      broadcastChat(joinedRoom);
    }
    broadcastState(joinedRoom);
  });

  // —— WebRTC 语音信令 ——
  socket.on('voice-join', () => {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom); if (!r) return;
    if (!r.voice) r.voice = new Set();
    // 让已在语音里的人向我发起连接（由他们当发起方，避免抢占）
    for (const pid of r.voice) if (pid !== playerId) emitToPlayer(r, pid, 'voice-initiate', { peer: playerId });
    r.voice.add(playerId);
    broadcastVoice(joinedRoom);
  });

  socket.on('voice-leave', () => {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom); if (!r || !r.voice) return;
    r.voice.delete(playerId);
    socket.to(joinedRoom).emit('voice-peer-left', { peerId: playerId });
    broadcastVoice(joinedRoom);
  });

  socket.on('voice-signal', ({ to, data }) => {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom); if (!r) return;
    emitToPlayer(r, to, 'voice-signal', { from: playerId, data });
  });

  socket.on('chat', (text) => {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    const p = r.table.player(playerId);
    text = String(text || '').trim().slice(0, 300);
    if (!text) return;
    r.chat.push({ name: p ? p.name : '玩家', text, t: Date.now() });
    if (r.chat.length > 200) r.chat.shift();
    broadcastChat(joinedRoom);
  });

  socket.on('leave', () => {
    handleLeave();
  });

  socket.on('disconnect', () => {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    // 标记断线，保留座位以便重连
    r.table.setConnected(playerId, false);
    const info = r.players.get(playerId);
    if (info) info.socketId = null;
    if (r.voice && r.voice.has(playerId)) { r.voice.delete(playerId); socket.to(joinedRoom).emit('voice-peer-left', { peerId: playerId }); broadcastVoice(joinedRoom); }
    if (r.table._tryReset) r.table._tryReset();
    broadcastState(joinedRoom);
  });

  function handleLeave() {
    if (!joinedRoom || !playerId) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;
    const p = r.table.player(playerId);
    const nm = p ? p.name : '玩家';
    if (r.voice && r.voice.has(playerId)) { r.voice.delete(playerId); socket.to(joinedRoom).emit('voice-peer-left', { peerId: playerId }); broadcastVoice(joinedRoom); }
    r.table.removePlayer(playerId);
    r.players.delete(playerId);
    r.chat.push({ sys: true, text: `${nm} 离开房间`, t: Date.now() });
    socket.leave(joinedRoom);
    broadcastState(joinedRoom);
    broadcastChat(joinedRoom);
    // 空房间清理
    if (r.table.activePlayers().length === 0) rooms.delete(joinedRoom);
    joinedRoom = null; playerId = null;
  }
});

// 定期清理超时空房间（2 小时无人）
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const anyConnected = [...r.players.values()].some(i => i.socketId);
    if (!anyConnected && now - r.createdAt > 2 * 3600 * 1000) rooms.delete(code);
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`德州扑克服务器已启动: http://localhost:${PORT}`));
