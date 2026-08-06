const { tokenize } = require('./tokenize');

const BOOST = { t: 6, g: 3, h: 2, b: 1 };

class SearchEngine {
  constructor(indexer) {
    this.indexer = indexer;
  }

  query(rawQuery, { limit = 50 } = {}) {
    const terms = [...new Set(tokenize(rawQuery))];
    if (!terms.length) return { query: rawQuery, total: 0, results: [] };

    const N = this.indexer.docs.size;
    const results = [];

    const candidateSets = terms.map((term) => this.indexer.index.get(term)).filter(Boolean);
    const common = new Set();
    if (candidateSets.length === terms.length) {
      const first = candidateSets[0];
      for (const relPath of first.keys()) common.add(relPath);
      for (let i = 1; i < candidateSets.length; i++) {
        for (const relPath of [...common]) {
          if (!candidateSets[i].has(relPath)) common.delete(relPath);
        }
        if (!common.size) break;
      }
    } else {
      // 部分词命中：退化为 OR，用命中词数加权
      const any = new Map();
      for (let i = 0; i < candidateSets.length; i++) {
        for (const relPath of candidateSets[i].keys()) {
          any.set(relPath, (any.get(relPath) || 0) + 1);
        }
      }
      for (const [relPath, hits] of any) {
        if (hits === candidateSets.length) common.add(relPath);
      }
      for (const [relPath, hits] of any) {
        if (!common.has(relPath)) common.add(relPath);
      }
      for (const relPath of [...common]) {
        if (any.get(relPath) < Math.max(1, Math.ceil(terms.length / 2))) common.delete(relPath);
      }
    }

    const hasFullMatch = candidateSets.length === terms.length && common.size > 0;
    const usePartial = !hasFullMatch;

    for (const relPath of common) {
      const doc = this.indexer.docs.get(relPath);
      if (!doc) continue;
      let score = 0;
      let matchedCount = 0;
      for (const term of terms) {
        const map = this.indexer.index.get(term);
        if (!map || !map.has(relPath)) continue;
        matchedCount++;
        const entry = map.get(relPath);
        const df = map.size;
        const idf = Math.log((N + 1) / (df + 1)) + 1;
        let s = 0;
        if (entry.t) s += entry.t * BOOST.t;
        if (entry.g) s += entry.g * BOOST.g;
        if (entry.h) s += entry.h * BOOST.h;
        if (entry.b) s += entry.b * BOOST.b;
        score += (1 + Math.log(1 + s)) * idf;
      }
      if (usePartial && matchedCount < Math.max(1, Math.ceil(terms.length / 2))) continue;
      if (usePartial) score *= matchedCount / terms.length;
      results.push({ relPath, score, matchedCount });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);

    const out = top.map((r) => {
      const doc = this.indexer.docs.get(r.relPath);
      return {
        relPath: r.relPath,
        title: doc.title,
        tags: doc.tags,
        score: Math.round(r.score * 100) / 100,
        size: doc.size,
        mtimeMs: doc.mtimeMs,
        snippet: this._snippet(doc, rawQuery),
        headings: doc.headings.slice(0, 8),
      };
    });
    return { query: rawQuery, total: out.length, results: out };
  }

  _snippet(doc, rawQuery) {
    const text = doc.body.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|~]/g, ' ').replace(/\s+/g, ' ');
    const q = rawQuery.trim().toLowerCase();
    let idx = -1;
    if (q) idx = text.toLowerCase().indexOf(q);
    if (idx === -1) {
      for (const term of [...tokenize(rawQuery)]) {
        idx = text.toLowerCase().indexOf(term);
        if (idx !== -1) break;
      }
    }
    const start = idx === -1 ? 0 : Math.max(0, idx - 60);
    const end = Math.min(text.length, start + 200);
    let snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    return snippet;
  }
}

module.exports = { SearchEngine };
