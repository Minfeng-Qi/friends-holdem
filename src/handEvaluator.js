'use strict';
// 德州扑克牌力评估：从 5-7 张牌中评出最佳 5 张牌的牌力。
// 牌用 {rank, suit} 表示：rank 2..14 (11=J,12=Q,13=K,14=A), suit 0..3。
// evaluate5 返回一个可按字典序比较的数组 [category, ...tiebreakers]，值越大牌越强。

const CATEGORY = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_KIND: 7,
  STRAIGHT_FLUSH: 8,
};

const CATEGORY_NAME = {
  0: '高牌', 1: '一对', 2: '两对', 3: '三条', 4: '顺子',
  5: '同花', 6: '葫芦', 7: '四条', 8: '同花顺',
};

// 评估恰好 5 张牌
function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // 统计每个点数出现次数
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // 按 [出现次数, 点数] 排序，次数多的优先，其次点数大的优先
  const groups = Object.keys(counts)
    .map(r => ({ rank: +r, count: counts[r] }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  // 顺子判定（含 A-2-3-4-5 轮子，此时最大牌算 5）
  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // 轮子
  }

  if (isFlush && straightHigh) return [CATEGORY.STRAIGHT_FLUSH, straightHigh];
  if (groups[0].count === 4)
    return [CATEGORY.FOUR_KIND, groups[0].rank, groups[1].rank];
  if (groups[0].count === 3 && groups[1].count === 2)
    return [CATEGORY.FULL_HOUSE, groups[0].rank, groups[1].rank];
  if (isFlush) return [CATEGORY.FLUSH, ...ranks];
  if (straightHigh) return [CATEGORY.STRAIGHT, straightHigh];
  if (groups[0].count === 3)
    return [CATEGORY.THREE_KIND, groups[0].rank, groups[1].rank, groups[2].rank];
  if (groups[0].count === 2 && groups[1].count === 2)
    return [CATEGORY.TWO_PAIR, groups[0].rank, groups[1].rank, groups[2].rank];
  if (groups[0].count === 2)
    return [CATEGORY.ONE_PAIR, groups[0].rank, groups[1].rank, groups[2].rank, groups[3].rank];
  return [CATEGORY.HIGH_CARD, ...ranks];
}

// 比较两个牌力数组：>0 表示 a 更强，<0 表示 b 更强，0 相等
function compareScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 从 5..7 张牌中评出最佳 5 张，返回 { score, cards, name }
function evaluateBest(cards) {
  if (cards.length < 5) throw new Error('need at least 5 cards');
  let best = null, bestCards = null;
  const n = cards.length;
  // 枚举所有 5 张组合
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluate5(combo);
            if (best === null || compareScore(score, best) > 0) {
              best = score;
              bestCards = combo;
            }
          }
  return { score: best, cards: bestCards, name: CATEGORY_NAME[best[0]] };
}

module.exports = { evaluate5, evaluateBest, compareScore, CATEGORY, CATEGORY_NAME };
