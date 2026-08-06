const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;
const LATIN_RE = /[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*/g;

function* tokenize(text) {
  if (!text) return;
  for (const m of text.matchAll(LATIN_RE)) {
    yield m[0].toLowerCase();
  }
  for (const m of text.matchAll(CJK_RE)) {
    const s = m[0];
    if (s.length === 1) {
      yield s;
    } else {
      for (let i = 0; i < s.length - 1; i++) yield s.slice(i, i + 2);
    }
  }
}

function tokenCountMap(text) {
  const map = new Map();
  for (const t of tokenize(text)) {
    map.set(t, (map.get(t) || 0) + 1);
  }
  return map;
}

module.exports = { tokenize, tokenCountMap };
