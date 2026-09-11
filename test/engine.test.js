'use strict';
const { Table } = require('../src/table');
const { evaluateBest, compareScore } = require('../src/handEvaluator');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', msg); } }

const C = (r, s) => ({ rank: r, suit: s });

// ---- 牌力评估基础校验 ----
function sc(cards) { return evaluateBest(cards).score; }
ok(sc([C(14,0),C(13,0),C(12,0),C(11,0),C(10,0),C(2,1),C(3,2)])[0] === 8, '皇家同花顺=8');
ok(sc([C(9,0),C(9,1),C(9,2),C(9,3),C(2,0),C(3,1),C(4,2)])[0] === 7, '四条=7');
ok(sc([C(10,0),C(10,1),C(10,2),C(4,0),C(4,1),C(2,3),C(7,3)])[0] === 6, '葫芦=6');
ok(sc([C(14,0),C(2,1),C(3,2),C(4,3),C(5,0),C(9,1),C(11,2)])[1] === 5, '轮子顺最大牌=5');
ok(compareScore(sc([C(14,0),C(14,1),C(9,2),C(9,3),C(4,0),C(2,1),C(3,2)]),
                sc([C(13,0),C(13,1),C(12,2),C(12,3),C(4,0),C(2,1),C(3,2)])) > 0, 'AA99>KKQQ');

// ---- 自动打完一局，检查筹码守恒 ----
function autoPlay(table, strategy) {
  let guard = 0;
  while (table.phase !== 'showdown' && table.phase !== 'waiting') {
    if (guard++ > 500) throw new Error('死循环');
    const turnSeat = table.currentTurn;
    if (turnSeat === -1) break;
    const p = table.seats[turnSeat];
    const st = table.getStateFor(p.id);
    const a = st.actions;
    if (!a) break;
    const move = strategy(p, a, st);
    const res = table.act(p.id, move.action, move.amount);
    if (!res.ok) throw new Error('非法操作: ' + res.error + ' by ' + p.name + ' ' + JSON.stringify(move));
  }
}

// 策略：多数跟注/看牌
function callingStation(p, a) {
  if (a.canCheck) return { action: 'check' };
  if (a.canCall) return { action: 'call' };
  return { action: 'fold' };
}

// 跑 200 局随机，检查每局后总筹码守恒
{
  const table = new Table({ maxSeats: 6, startingStack: 1000, smallBlind: 10, bigBlind: 20 });
  ['A','B','C','D'].forEach((n,i) => table.addPlayer('p'+i, n));
  const TOTAL = 4 * 1000;
  let conserved = true;
  for (let hand = 0; hand < 200; hand++) {
    // 有人筹码为0会被跳过；不足2人则停
    if (table.eligible().length < 2) break;
    const r = table.startHand();
    if (!r.ok) break;
    // 随机策略
    autoPlay(table, (p, a, st) => {
      const roll = Math.random();
      if (a.canRaise && roll < 0.2) {
        const to = Math.min(a.maxRaiseTo, a.minRaiseTo + Math.floor(Math.random()*3)*table.bigBlind);
        return { action: 'raise', amount: to };
      }
      if (roll < 0.05 && a.canAllIn) return { action: 'allin' };
      if (a.canCheck) return { action: 'check' };
      if (a.canCall) return { action: 'call' };
      return { action: 'fold' };
    });
    const sum = table.activePlayers().reduce((s,p)=>s+p.stack,0);
    if (sum !== TOTAL) { conserved = false; console.log('  局', hand, '筹码总和', sum, '≠', TOTAL); break; }
  }
  ok(conserved, '200局随机对局筹码守恒');
}

// ---- 明确的边池场景 ----
// 三人：短码全下，构成主池+边池
{
  const t = new Table({ maxSeats: 6, startingStack: 1000, smallBlind: 10, bigBlind: 20 });
  t.addPlayer('s','Short'); t.addPlayer('m','Mid'); t.addPlayer('b','Big');
  t.seats[t.findSeat('s')].stack = 100;   // 短码
  t.seats[t.findSeat('m')].stack = 500;
  t.seats[t.findSeat('b')].stack = 500;
  const before = 100 + 500 + 500;
  t.startHand();
  // 简单地全部跟注/全下打到底
  autoPlay(t, (p, a) => {
    if (a.canAllIn && p.stack <= 100) return { action: 'allin' };
    if (a.canCheck) return { action: 'check' };
    if (a.canCall) return { action: 'call' };
    return { action: 'fold' };
  });
  const after = t.activePlayers().reduce((s,p)=>s+p.stack,0);
  ok(after === before, '边池场景筹码守恒 (' + after + '==' + before + ')');
  ok(t.lastResult && t.lastResult.pots.length >= 1, '产生了结算底池');
}

// ---- 单挑盲注规则 ----
{
  const t = new Table({ maxSeats: 6, startingStack: 1000, smallBlind: 10, bigBlind: 20 });
  t.addPlayer('x','X'); t.addPlayer('y','Y');
  t.startHand();
  // 单挑：庄家=小盲，翻牌前庄家先动
  const dealerSeat = t.dealer;
  ok(t.currentTurn === dealerSeat, '单挑翻牌前庄家(小盲)先行动');
  const sum0 = t.activePlayers().reduce((s,p)=>s+p.stack,0) + t.potTotal();
  ok(sum0 === 2000, '单挑下盲后筹码总和(含底池)=2000');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
