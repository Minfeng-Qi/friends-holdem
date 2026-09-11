'use strict';
// 机器人 AI —— 借鉴 CFR/GTO 的核心：以真实胜率(equity) + 底池赔率做 EV 决策，
// 并用混合策略（价值/半诈唬/纯诈唬按频率随机、多种下注尺度）保持平衡、不易被针对。
const { evaluateBest, compareScore } = require('./handEvaluator');

// —— 蒙特卡洛胜率：我方两张底牌 vs N 个随机对手，随机补齐公共牌 ——
function equity(hole, community, opponents, iters) {
  const known = new Set([...hole, ...community].map(c => c.rank * 4 + c.suit));
  const full = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) {
    const idc = r * 4 + s; if (!known.has(idc)) full.push({ rank: r, suit: s });
  }
  const need = 5 - community.length;
  const take = need + 2 * opponents;
  let win = 0, tie = 0;
  for (let it = 0; it < iters; it++) {
    // 部分 Fisher-Yates：只洗出需要的前 take 张
    const drawn = [];
    for (let k = 0; k < take; k++) {
      const j = k + Math.floor(Math.random() * (full.length - k));
      const tmp = full[k]; full[k] = full[j]; full[j] = tmp;
      drawn.push(full[k]);
    }
    const board = community.concat(drawn.slice(0, need));
    const myScore = evaluateBest(hole.concat(board)).score;
    let beat = true, tied = false, idx = need;
    for (let o = 0; o < opponents; o++) {
      const oh = [drawn[idx], drawn[idx + 1]]; idx += 2;
      const cmp = compareScore(myScore, evaluateBest(oh.concat(board)).score);
      if (cmp < 0) { beat = false; break; }
      if (cmp === 0) tied = true;
    }
    if (beat) { if (tied) tie++; else win++; }
  }
  return (win + tie * 0.5) / iters;
}

// 翻牌前手牌质量（用于对“对手是随机牌”的乐观估计做收紧修正）
function preflopStrength(hole) {
  const rs = hole.map(c => c.rank).sort((a, b) => b - a);
  const [a, b] = rs;
  const suited = hole[0].suit === hole[1].suit;
  let s = (a - 2) / 12 * 0.45;
  if (a === b) s += 0.34 + (a - 2) / 12 * 0.18;
  else {
    s += (b - 2) / 12 * 0.13;
    const gap = a - b;
    if (gap === 1) s += 0.07; else if (gap === 2) s += 0.04; else if (gap === 3) s += 0.02;
    if (suited) s += 0.07;
  }
  return Math.max(0, Math.min(1, s));
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// 返回机器人的行动：{type, amount?}
function decide(table, id) {
  const p = table.player(id);
  if (!p) return { type: 'fold' };
  const toCall = table.currentBet - p.bet;
  const pot = table.potTotal();
  const bb = table.bigBlind;
  const comm = table.community;
  const opponents = Math.max(1, table.inHandPlayers().filter(x => x.id !== id).length);

  // 迭代次数随街数/对手数调整，兼顾速度
  const iters = comm.length === 0 ? 240 : comm.length === 3 ? 320 : 240;
  let eq = equity(p.hole, comm, opponents, iters);
  if (comm.length === 0) eq = eq * 0.72 + preflopStrength(p.hole) * 0.28; // 翻前收紧
  eq += (Math.random() - 0.5) * 0.05; // 轻微扰动
  eq = Math.max(0, Math.min(1, eq));

  const minRaiseTo = Math.min(table.currentBet + table.minRaise, p.bet + p.stack);
  const maxRaiseTo = p.bet + p.stack;
  const canRaise = p.stack > toCall;
  const sizeTo = frac => {
    const size = Math.max(bb * 2, Math.round(pot * frac));
    let to = Math.min(maxRaiseTo, table.currentBet + size);
    return Math.max(Math.min(to, maxRaiseTo), minRaiseTo);
  };
  const r = Math.random();

  if (toCall <= 0) {
    // 可看牌：价值下注(eq高) / 半诈唬(中等偶尔) / 纯诈唬(低eq少量)
    if (eq > 0.80 && canRaise) {
      if (eq > 0.90 && r < 0.30) return { type: 'allin' };
      return { type: 'raise', amount: sizeTo(pick([0.5, 0.75, 1.0])) };
    }
    if (eq > 0.56 && canRaise && r < 0.72) return { type: 'raise', amount: sizeTo(pick([0.4, 0.66])) };
    if (eq < 0.34 && canRaise && r < 0.16) return { type: 'raise', amount: sizeTo(0.5) };
    return { type: 'check' };
  }

  // 面对下注
  const potOdds = toCall / (pot + toCall);
  if (eq > 0.82 && canRaise && r < 0.6) {
    if (eq > 0.90 && r < 0.35) return { type: 'allin' };
    return { type: 'raise', amount: sizeTo(pick([0.6, 0.9])) };
  }
  if (eq > 0.50 && eq < 0.66 && canRaise && r < 0.12) return { type: 'raise', amount: sizeTo(0.6) }; // 半诈唬
  if (eq >= potOdds + 0.02) return { type: 'call' };
  if (toCall <= bb && eq > 0.30) return { type: 'call' }; // 很便宜就跟
  if (eq < 0.25 && canRaise && r < 0.05) return { type: 'raise', amount: sizeTo(0.6) }; // 极少纯诈唬
  return { type: 'fold' };
}

module.exports = { decide, equity, preflopStrength };
