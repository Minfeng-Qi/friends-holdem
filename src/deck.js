'use strict';
// 一副 52 张牌。rank 2..14，suit 0..3 (0黑桃♠ 1红桃♥ 2梅花♣ 3方块♦)
function freshDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++)
    for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s });
  return deck;
}
// Fisher-Yates 洗牌
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
module.exports = { freshDeck, shuffle };
