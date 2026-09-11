'use strict';
const { freshDeck, shuffle } = require('./deck');
const { evaluateBest, compareScore } = require('./handEvaluator');

// 一张牌桌 = 一个房间的游戏。管理座位、发牌、下注、结算。
// 不直接依赖 Socket；通过 getStateFor(playerId) 输出可广播的状态。
// 根据人数生成位置标签（从小盲到庄家）：SB, BB, [UTG, EP, MP, CO...], BTN
function positionLabels(n) {
  if (n <= 1) return ['BTN'];
  if (n === 2) return ['SB', 'BB'];
  const need = n - 3; // BB 与 BTN 之间的中间位数量
  let mids;
  if (need <= 0) mids = [];
  else if (need === 1) mids = ['UTG'];
  else {
    const between = need - 2;
    const fill = ['EP', 'MP'].slice(2 - Math.min(2, between)); // 1→[MP], 2→[EP,MP]
    mids = ['UTG', ...fill, 'CO'];
    while (mids.length < need) mids.splice(mids.length - 1, 0, 'MP');
  }
  return ['SB', 'BB', ...mids, 'BTN'];
}

class Table {
  constructor(opts = {}) {
    this.maxSeats = opts.maxSeats || 6;
    this.smallBlind = opts.smallBlind || 10;
    this.bigBlind = opts.bigBlind || 20;
    this.startingStack = opts.startingStack || 1000;
    this.seats = new Array(this.maxSeats).fill(null); // seat -> player | null
    this.dealer = -1;      // 庄家按钮所在座位
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | showdown
    this.deck = [];
    this.community = [];
    this.currentTurn = -1;  // 当前该行动的座位
    this.currentBet = 0;    // 本轮需要跟到的额度
    this.minRaise = this.bigBlind;
    this.handId = 0;
    this.log = [];          // 最近的事件文本
    this.lastResult = null; // 上一局结算结果
    this.resetVotes = new Set(); // 重置筹码投票
  }

  // ---------- 座位管理 ----------
  addPlayer(id, name) {
    if (this.findSeat(id) !== -1) return { ok: true, seat: this.findSeat(id) };
    let seat = this.seats.findIndex(s => s === null);
    if (seat === -1) {
      // 满座时给真人腾位：先让一个不在本局的机器人下场，其次回收已掉线且不在本局的座位
      let victim = this.seats.findIndex(s => s && s.isBot && !s.inHand);
      if (victim === -1) victim = this.seats.findIndex(s => s && !s.isBot && !s.connected && !s.inHand);
      if (victim === -1) return { ok: false, error: '牌桌已满，等这局结束再加入' };
      const old = this.seats[victim];
      this.pushLog(`${old.name} 让出座位`);
      this.seats[victim] = null;
      seat = victim;
    }
    this.seats[seat] = {
      id, name,
      seat,
      stack: this.startingStack,
      hole: [],
      inHand: false,     // 本局是否还在牌里（未弃牌）
      bet: 0,            // 本轮已下注
      committed: 0,      // 本局累计投入（算边池用）
      acted: false,      // 本轮是否已行动
      allIn: false,
      sittingOut: false, // 坐着但不参与下一局
      connected: true,
      autoLeaveNext: false,
      isBot: false,
      position: '',
    };
    this.pushLog(`${name} 加入了牌桌`);
    return { ok: true, seat };
  }

  addBot(name) {
    const id = 'bot_' + Math.random().toString(36).slice(2, 9);
    const res = this.addPlayer(id, name);
    if (!res.ok) return null;
    const p = this.player(id); if (p) p.isBot = true;
    return id;
  }

  // 当前所有机器人
  bots() { return this.activePlayers().filter(p => p.isBot); }

  removePlayer(id) {
    const seat = this.findSeat(id);
    if (seat === -1) return;
    const p = this.seats[seat];
    // 若正在牌局中，先当作弃牌
    if (this.phase !== 'waiting' && this.phase !== 'showdown' && p.inHand) {
      p.inHand = false;
      p.acted = true;
    }
    this.pushLog(`${p.name} 离开了牌桌`);
    this.seats[seat] = null;
    // 若离开导致牌局无法继续，收尾
    if (this.phase !== 'waiting') this._maybeConclude();
  }

  setConnected(id, connected) {
    const seat = this.findSeat(id);
    if (seat === -1) return;
    this.seats[seat].connected = connected;
  }

  findSeat(id) { return this.seats.findIndex(s => s && s.id === id); }
  player(id) { const s = this.findSeat(id); return s === -1 ? null : this.seats[s]; }
  activePlayers() { return this.seats.filter(s => s !== null); }
  // 本局参与者（发过牌、未弃牌）
  inHandPlayers() { return this.seats.filter(s => s && s.inHand); }
  // 有资格开局的人：坐着、有筹码、不 sitOut
  eligible() { return this.seats.filter(s => s && s.stack > 0 && !s.sittingOut); }

  toggleSitOut(id, val) {
    const p = this.player(id);
    if (p) p.sittingOut = (val === undefined ? !p.sittingOut : !!val);
  }

  // ---------- 座位顺序辅助 ----------
  // 从 seat 之后开始，返回下一个满足 filter 的座位；找不到返回 -1
  nextSeat(from, filter) {
    for (let i = 1; i <= this.maxSeats; i++) {
      const s = (from + i) % this.maxSeats;
      if (this.seats[s] && filter(this.seats[s])) return s;
    }
    return -1;
  }

  // ---------- 开局 ----------
  startHand() {
    const players = this.eligible();
    if (players.length < 2) return { ok: false, error: '至少需要 2 名有筹码的玩家' };

    this.handId++;
    this.phase = 'preflop';
    this.community = [];
    this.deck = shuffle(freshDeck());
    this.lastResult = null;
    this.resetVotes.clear();

    for (const p of this.activePlayers()) {
      p.hole = [];
      p.bet = 0;
      p.committed = 0;
      p.acted = false;
      p.allIn = false;
      p.position = '';
      p.inHand = p.stack > 0 && !p.sittingOut;
    }

    // 移动庄家按钮到下一个有效座位
    this.dealer = this.nextSeat(this.dealer, p => p.inHand);
    this.pushLog(`—— 第 ${this.handId} 局开始 ——`);

    const inhand = this.inHandPlayers();
    const heads = inhand.length === 2;

    // 确定小盲/大盲座位
    let sbSeat, bbSeat;
    if (heads) {
      // 单挑：庄家 = 小盲
      sbSeat = this.dealer;
      bbSeat = this.nextSeat(this.dealer, p => p.inHand);
    } else {
      sbSeat = this.nextSeat(this.dealer, p => p.inHand);
      bbSeat = this.nextSeat(sbSeat, p => p.inHand);
    }

    // 下盲注
    this._postBlind(sbSeat, this.smallBlind, '小盲');
    this._postBlind(bbSeat, this.bigBlind, '大盲');
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    // 发两张底牌
    for (let round = 0; round < 2; round++)
      for (const p of this.inHandPlayers()) p.hole.push(this.deck.pop());

    // 大盲的下注是被动的，不算“已行动”，保留其加注/看牌选择权
    for (const p of this.inHandPlayers()) p.acted = false;

    // 首个行动者
    if (heads) {
      this.currentTurn = sbSeat; // 单挑翻牌前小盲(庄家)先动
    } else {
      this.currentTurn = this.nextSeat(bbSeat, p => this._canAct(p));
    }

    this.assignPositions();

    // 极端情况：盲注已让人 all-in，直接推进
    this._skipIfNoAction();
    return { ok: true };
  }

  _postBlind(seat, amount, label) {
    const p = this.seats[seat];
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    p.bet = pay;
    p.committed += pay;
    if (p.stack === 0) p.allIn = true;
    this.pushLog(`${p.name} 下${label} ${pay}`);
  }

  _canAct(p) { return p && p.inHand && !p.allIn; }

  // ---------- 玩家行动 ----------
  // action: 'fold' | 'check' | 'call' | 'raise' (amount=加注到的总额) | 'allin'
  act(id, action, amount) {
    if (this.phase === 'waiting' || this.phase === 'showdown')
      return { ok: false, error: '现在不是下注阶段' };
    const seat = this.findSeat(id);
    if (seat === -1) return { ok: false, error: '你不在牌桌上' };
    if (seat !== this.currentTurn) return { ok: false, error: '还没轮到你' };
    const p = this.seats[seat];
    if (!this._canAct(p)) return { ok: false, error: '你无法行动' };

    const toCall = this.currentBet - p.bet;

    switch (action) {
      case 'fold':
        p.inHand = false;
        p.acted = true;
        this.pushLog(`${p.name} 弃牌`);
        break;

      case 'check':
        if (toCall > 0) return { ok: false, error: '有下注，不能看牌，只能跟注/加注/弃牌' };
        p.acted = true;
        this.pushLog(`${p.name} 看牌`);
        break;

      case 'call': {
        if (toCall <= 0) return { ok: false, error: '无需跟注，请看牌' };
        const pay = Math.min(toCall, p.stack);
        p.stack -= pay; p.bet += pay; p.committed += pay;
        if (p.stack === 0) p.allIn = true;
        p.acted = true;
        this.pushLog(`${p.name} 跟注 ${pay}${p.allIn ? ' (全下)' : ''}`);
        break;
      }

      case 'allin': {
        const pay = p.stack;
        if (pay <= 0) return { ok: false, error: '你没有筹码' };
        const newTotal = p.bet + pay;
        const raiseAmt = newTotal - this.currentBet;
        p.stack = 0; p.bet = newTotal; p.committed += pay; p.allIn = true; p.acted = true;
        if (newTotal > this.currentBet) {
          // 构成加注（哪怕不足最小加注额）
          if (raiseAmt >= this.minRaise) this.minRaise = raiseAmt;
          this.currentBet = newTotal;
          this._reopen(seat);
        }
        this.pushLog(`${p.name} 全下 ${pay}`);
        break;
      }

      case 'raise': {
        // amount = 加注到的“总额”
        const raiseTo = Math.floor(amount);
        if (isNaN(raiseTo)) return { ok: false, error: '加注额无效' };
        const minTo = this.currentBet + this.minRaise;
        const maxTo = p.bet + p.stack;
        if (raiseTo > maxTo) return { ok: false, error: '筹码不足' };
        if (raiseTo < minTo && raiseTo !== maxTo)
          return { ok: false, error: `加注至少要到 ${minTo}` };
        if (raiseTo <= this.currentBet) return { ok: false, error: '加注额必须高于当前注' };
        const pay = raiseTo - p.bet;
        const raiseAmt = raiseTo - this.currentBet;
        p.stack -= pay; p.bet = raiseTo; p.committed += pay;
        if (p.stack === 0) p.allIn = true;
        if (raiseAmt >= this.minRaise) this.minRaise = raiseAmt;
        this.currentBet = raiseTo;
        p.acted = true;
        this._reopen(seat);
        this.pushLog(`${p.name} 加注至 ${raiseTo}${p.allIn ? ' (全下)' : ''}`);
        break;
      }

      default:
        return { ok: false, error: '未知操作' };
    }

    this._advance();
    return { ok: true };
  }

  // 加注后重开其他人的行动权
  _reopen(raiserSeat) {
    for (const p of this.inHandPlayers())
      if (p.seat !== raiserSeat && !p.allIn) p.acted = false;
  }

  // ---------- 推进游戏 ----------
  _advance() {
    // 只剩一人 -> 直接获胜
    if (this.inHandPlayers().length <= 1) return this._concludeHand();

    // 找下一个需要行动的人
    const next = this.nextSeat(this.currentTurn, p => this._needsAction(p));
    if (next !== -1) { this.currentTurn = next; return; }

    // 本轮结束 -> 进入下一街
    this._nextStreet();
  }

  _needsAction(p) {
    return p.inHand && !p.allIn && (!p.acted || p.bet < this.currentBet);
  }

  // 还能行动的人数（>1 才需要继续下注）
  _actionableCount() {
    return this.inHandPlayers().filter(p => !p.allIn).length;
  }

  _skipIfNoAction() {
    // 若无人需要行动，直接推进
    const next = this.nextSeat(this.currentTurn - 1, p => this._needsAction(p));
    // currentTurn 可能已被设置为有效行动者；若该人不需要行动则推进
    if (!this._needsAction(this.seats[this.currentTurn] || {})) {
      const n = this.nextSeat(this.dealer, p => this._needsAction(p));
      if (n === -1) this._nextStreet();
      else this.currentTurn = n;
    }
  }

  _collectBets() {
    for (const p of this.activePlayers()) p.bet = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    for (const p of this.inHandPlayers()) if (!p.allIn) p.acted = false;
  }

  _nextStreet() {
    this._collectBets();

    if (this.phase === 'preflop') { this.phase = 'flop'; this.deck.pop(); this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.pushLog('翻牌'); }
    else if (this.phase === 'flop') { this.phase = 'turn'; this.deck.pop(); this.community.push(this.deck.pop()); this.pushLog('转牌'); }
    else if (this.phase === 'turn') { this.phase = 'river'; this.deck.pop(); this.community.push(this.deck.pop()); this.pushLog('河牌'); }
    else if (this.phase === 'river') { return this._concludeHand(); }

    // 若最多只剩一人能行动，跳过下注直接发完剩余公共牌
    if (this._actionableCount() <= 1) {
      // 无需下注，继续发牌直到河牌然后摊牌
      this.currentTurn = -1;
      return this._runOutBoard();
    }
    // 翻后首个行动者：庄家左手第一个还能行动的人
    this.currentTurn = this.nextSeat(this.dealer, p => this._canAct(p));
    if (this.currentTurn === -1) return this._runOutBoard();
  }

  _runOutBoard() {
    while (this.community.length < 5 && this.phase !== 'river') {
      if (this.phase === 'preflop') { this.phase = 'flop'; this.deck.pop(); this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); }
      else if (this.phase === 'flop') { this.phase = 'turn'; this.deck.pop(); this.community.push(this.deck.pop()); }
      else if (this.phase === 'turn') { this.phase = 'river'; this.deck.pop(); this.community.push(this.deck.pop()); }
    }
    if (this.community.length < 5) {
      // 从当前 phase 补齐到 5 张
      while (this.community.length < 5) { this.deck.pop(); this.community.push(this.deck.pop()); }
      this.phase = 'river';
    }
    this._concludeHand();
  }

  _maybeConclude() {
    if (this.inHandPlayers().length <= 1 && this.phase !== 'waiting' && this.phase !== 'showdown')
      this._concludeHand();
  }

  // ---------- 结算 ----------
  _concludeHand() {
    const contenders = this.inHandPlayers();

    // 只剩一人：直接拿走全部
    if (contenders.length === 1) {
      const total = this.activePlayers().reduce((s, p) => s + p.committed, 0);
      const w = contenders[0];
      w.stack += total;
      this.lastResult = {
        pots: [{ amount: total, winners: [{ id: w.id, name: w.name, share: total }] }],
        showdown: false,
        board: this.community.slice(),
        hands: [],
      };
      this.pushLog(`${w.name} 赢得底池 ${total}（其他人已弃牌）`);
      this.phase = 'showdown';
      return;
    }

    // 摊牌：计算每人牌力
    const evals = {};
    for (const p of contenders)
      evals[p.id] = evaluateBest([...p.hole, ...this.community]);

    // 构建（边）池
    const pots = this._buildPots();
    const resultPots = [];
    const handInfo = contenders.map(p => ({
      id: p.id, name: p.name, hole: p.hole.slice(),
      best: evals[p.id].cards, handName: evals[p.id].name,
    }));

    for (const pot of pots) {
      const eligible = pot.eligible.filter(id => this.player(id) && this.player(id).inHand);
      if (eligible.length === 0) continue;
      // 找最佳牌力
      let best = null;
      for (const id of eligible) {
        if (best === null || compareScore(evals[id].score, evals[best].score) > 0) best = id;
      }
      const winners = eligible.filter(id => compareScore(evals[id].score, evals[best].score) === 0);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      // 余数按庄家左手起分配
      const ordered = this._orderFromDealer(winners);
      const winRecords = [];
      for (const id of ordered) {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder -= 1; }
        this.player(id).stack += amt;
        winRecords.push({ id, name: this.player(id).name, share: amt });
      }
      resultPots.push({ amount: pot.amount, winners: winRecords });
      const names = winRecords.map(w => `${w.name}(+${w.share})`).join('、');
      this.pushLog(`底池 ${pot.amount}：${names} [${evals[best].name}]`);
    }

    this.lastResult = { pots: resultPots, showdown: true, board: this.community.slice(), hands: handInfo };
    this.phase = 'showdown';
  }

  _buildPots() {
    // 依据每人 committed 分层建池；弃牌者的投入算“死钱”但无资格赢
    let contrib = this.activePlayers()
      .filter(p => p.committed > 0)
      .map(p => ({ id: p.id, committed: p.committed, folded: !p.inHand }));
    const pots = [];
    while (contrib.length > 0) {
      const min = Math.min(...contrib.map(c => c.committed));
      let amount = 0;
      for (const c of contrib) { amount += min; c.committed -= min; }
      const eligible = contrib.filter(c => !c.folded).map(c => c.id);
      if (amount > 0) {
        // 合并资格相同的相邻层
        const last = pots[pots.length - 1];
        const sameSet = last && last.eligible.length === eligible.length &&
          last.eligible.every(id => eligible.includes(id));
        if (sameSet) last.amount += amount;
        else pots.push({ amount, eligible });
      }
      contrib = contrib.filter(c => c.committed > 0);
    }
    return pots;
  }

  _orderFromDealer(ids) {
    const order = [];
    for (let i = 1; i <= this.maxSeats; i++) {
      const s = (this.dealer + i) % this.maxSeats;
      if (this.seats[s] && ids.includes(this.seats[s].id)) order.push(this.seats[s].id);
    }
    return order.length ? order : ids;
  }

  // ---------- 当前底池（用于展示） ----------
  potTotal() {
    return this.activePlayers().reduce((s, p) => s + p.committed, 0);
  }

  // ---------- 重置筹码（需全体同意） ----------
  // 参与投票的人：在座且在线
  _neededVoters() { return this.activePlayers().filter(p => p.connected && !p.isBot); }

  voteReset(id) {
    if (this.phase !== 'waiting' && this.phase !== 'showdown')
      return { ok: false, error: '请等本局结束后再发起重置' };
    const p = this.player(id);
    if (!p) return { ok: false, error: '你不在牌桌上' };
    if (this.resetVotes.has(id)) this.resetVotes.delete(id);
    else this.resetVotes.add(id);
    this._tryReset();
    return { ok: true };
  }

  _tryReset() {
    if (this.phase !== 'waiting' && this.phase !== 'showdown') return;
    const needed = this._neededVoters();
    if (needed.length >= 1 && needed.every(p => this.resetVotes.has(p.id)))
      this.performReset();
  }

  performReset() {
    for (const p of this.activePlayers()) {
      p.stack = this.startingStack;
      p.hole = []; p.bet = 0; p.committed = 0;
      p.inHand = false; p.allIn = false; p.acted = false; p.sittingOut = false; p.position = '';
    }
    this.resetVotes.clear();
    this.community = []; this.lastResult = null;
    this.phase = 'waiting'; this.handId = 0; this.dealer = -1;
    this.pushLog('全体同意，重开对局：每人筹码重置为 ' + this.startingStack);
  }

  resetInfo(viewerId) {
    const needed = this._neededVoters();
    const neededIds = needed.map(p => p.id);
    const count = [...this.resetVotes].filter(id => neededIds.includes(id)).length;
    return {
      count, total: needed.length,
      mine: this.resetVotes.has(viewerId),
      available: this.phase === 'waiting' || this.phase === 'showdown',
      voters: needed.filter(p => this.resetVotes.has(p.id)).map(p => p.name),
    };
  }

  // 依据庄家按钮为本局在牌玩家分配位置标签
  assignPositions() {
    const order = [];
    for (let i = 1; i <= this.maxSeats; i++) {
      const st = (this.dealer + i) % this.maxSeats;
      const p = this.seats[st];
      if (p && p.inHand) order.push(p);
    }
    const n = order.length;
    if (n === 2) {
      const dealerP = this.seats[this.dealer];
      order.forEach(p => { p.position = (p === dealerP) ? 'SB' : 'BB'; }); // 单挑庄家=小盲
      return;
    }
    const labels = positionLabels(n);
    order.forEach((p, i) => { p.position = labels[i]; });
  }

  // ---------- 状态输出 ----------
  pushLog(text) {
    this.log.push(text);
    if (this.log.length > 60) this.log.shift();
  }

  // 给指定玩家看的状态（隐藏他人底牌，摊牌时公开）
  getStateFor(viewerId) {
    const showdown = this.phase === 'showdown' && this.lastResult && this.lastResult.showdown;
    const players = this.seats.map(p => {
      if (!p) return null;
      const reveal = p.id === viewerId || (showdown && p.inHand);
      return {
        id: p.id, name: p.name, seat: p.seat, stack: p.stack, isBot: p.isBot, position: p.position || '',
        bet: p.bet, committed: p.committed, inHand: p.inHand,
        allIn: p.allIn, sittingOut: p.sittingOut, connected: p.connected,
        isDealer: p.seat === this.dealer,
        isTurn: p.seat === this.currentTurn && this.phase !== 'showdown' && this.phase !== 'waiting',
        hole: reveal ? p.hole : (p.inHand ? [{ hidden: true }, { hidden: true }] : []),
      };
    });
    // 该玩家可用操作
    let actions = null;
    const me = this.player(viewerId);
    if (me && me.seat === this.currentTurn && this._canAct(me) &&
        this.phase !== 'waiting' && this.phase !== 'showdown') {
      const toCall = this.currentBet - me.bet;
      actions = {
        canCheck: toCall <= 0,
        canCall: toCall > 0,
        callAmount: Math.min(toCall, me.stack),
        canRaise: me.stack > toCall,
        minRaiseTo: Math.min(this.currentBet + this.minRaise, me.bet + me.stack),
        maxRaiseTo: me.bet + me.stack,
        canAllIn: me.stack > 0,
        stack: me.stack,
      };
    }
    return {
      phase: this.phase,
      handId: this.handId,
      community: this.community,
      pot: this.potTotal(),
      currentBet: this.currentBet,
      dealer: this.dealer,
      currentTurn: this.currentTurn,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      maxSeats: this.maxSeats,
      players,
      actions,
      lastResult: this.lastResult,
      log: this.log.slice(-20),
      canStart: this.phase === 'waiting' || this.phase === 'showdown',
      eligibleCount: this.eligible().length,
      reset: this.resetInfo(viewerId),
    };
  }
}

module.exports = { Table };
