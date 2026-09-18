const fs = require('node:fs');
const path = require('node:path');

// SM-2 间隔重复算法
// quality: 0-5 (0=完全忘记, 5=完美回忆)
// interval: 当前间隔天数
// repetition: 连续正确次数
function sm2(interval, repetition, quality) {
  if (quality < 3) {
    // 忘记：重置
    return { interval: 1, repetition: 0 };
  }
  // 记住：增加间隔
  let newInterval;
  if (repetition === 0) {
    newInterval = 1;
  } else if (repetition === 1) {
    newInterval = 3;
  } else {
    newInterval = Math.round(interval * 2.5);
  }
  return { interval: newInterval, repetition: repetition + 1 };
}

class ReviewManager {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'review.json');
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return { notes: {} };
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {}
  }

  // 获取笔记的复习状态
  getNoteState(relPath) {
    return this.data.notes[relPath] || {
      interval: 0,
      repetition: 0,
      nextReview: 0,
      lastReview: 0,
      reviewCount: 0,
      enrolled: false,
    };
  }

  // 检查笔记是否在复习计划中
  isEnrolled(relPath) {
    const state = this.getNoteState(relPath);
    return state.enrolled === true;
  }

  // 将笔记加入复习计划
  enrollNote(relPath) {
    const state = this.getNoteState(relPath);
    this.data.notes[relPath] = {
      ...state,
      enrolled: true,
    };
    this._save();
    return this.data.notes[relPath];
  }

  // 将笔记移出复习计划
  unenrollNote(relPath) {
    const state = this.getNoteState(relPath);
    this.data.notes[relPath] = {
      ...state,
      enrolled: false,
    };
    this._save();
    return this.data.notes[relPath];
  }

  // 标记笔记已复习（quality: 0-5）
  markReviewed(relPath, quality) {
    const state = this.getNoteState(relPath);
    const { interval, repetition } = sm2(state.interval, state.repetition, quality);
    const now = Date.now();
    const nextReview = now + interval * 24 * 60 * 60 * 1000;
    this.data.notes[relPath] = {
      interval,
      repetition,
      nextReview,
      lastReview: now,
      reviewCount: (state.reviewCount || 0) + 1,
    };
    this._save();
    return this.data.notes[relPath];
  }

  // 获取今日需要复习的笔记列表
  getDueNotes(allRelPaths) {
    const now = Date.now();
    const due = [];
    const newNotes = [];
    for (const relPath of allRelPaths) {
      // 只处理已加入复习计划的笔记
      if (!this.isEnrolled(relPath)) continue;
      
      const state = this.getNoteState(relPath);
      if (state.repetition === 0) {
        // 从未复习过的新笔记
        newNotes.push({ relPath, state, isNew: true });
      } else if (state.nextReview <= now) {
        // 到期需要复习
        due.push({ relPath, state, isDue: true });
      }
    }
    // 按到期时间排序（越早到期越优先）
    due.sort((a, b) => a.state.nextReview - b.state.nextReview);
    // 返回：到期的 + 新笔记（最多 20 条）
    return [...due, ...newNotes].slice(0, 20);
  }

  // 获取复习统计
  getStats(allRelPaths) {
    const now = Date.now();
    let dueCount = 0;
    let newCount = 0;
    let reviewedCount = 0;
    let masteredCount = 0;
    let enrolledCount = 0;
    for (const relPath of allRelPaths) {
      // 只统计已加入复习计划的笔记
      if (!this.isEnrolled(relPath)) continue;
      
      enrolledCount++;
      const state = this.getNoteState(relPath);
      if (state.repetition === 0) {
        newCount++;
      } else if (state.nextReview <= now) {
        dueCount++;
      } else if (state.interval >= 21) {
        masteredCount++;
      } else {
        reviewedCount++;
      }
    }
    return { total: enrolledCount, newCount, dueCount, reviewedCount, masteredCount };
  }
}

module.exports = { ReviewManager };
