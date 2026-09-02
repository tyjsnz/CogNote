class AIError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status || 0;
  }
}

class DeepSeekAI {
  constructor(config) {
    this.apiKey = (config.apiKey || '').trim();
    this.baseUrl = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = config.model || 'deepseek-chat';
    this.timeoutMs = config.timeoutMs || 120000;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async chat(messages, { temperature = 0.7, maxTokens = 4096, json = false } = {}) {
    if (!this.isConfigured()) {
      throw new AIError('未配置 DeepSeek API Key，请在 config.json 的 deepseek.apiKey 中填写后再使用 AI 功能。', 401);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature,
          max_tokens: maxTokens,
          response_format: json ? { type: 'json_object' } : undefined,
        }),
        signal: controller.signal,
      });
      const raw = await resp.text();
      if (!resp.ok) {
        throw new AIError(`DeepSeek API 错误(${resp.status}): ${raw.slice(0, 300)}`, resp.status);
      }
      const data = JSON.parse(raw);
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new AIError('DeepSeek 返回内容为空', resp.status);
      return content.trim();
    } catch (err) {
      if (err instanceof AIError) throw err;
      if (err.name === 'AbortError') throw new AIError('DeepSeek 请求超时');
      throw new AIError(`请求失败: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  _system(kb) {
    return (
      `你是本地知识库智能体，擅长对中文嵌入式开发笔记进行整理、归类、扩展与复习。` +
      (kb ? `\n当前知识库收录主题包括：${kb}。回答使用 Markdown，内容专业、精炼、准确，不编造未提及的技术细节。` : '')
    );
  }

  async classifyNote(doc) {
    const messages = [
      { role: 'system', content: this._system() },
      {
        role: 'user',
        content:
          `请分析下面这篇笔记，给出归类建议。\n` +
          `笔记路径：${doc.relPath}\n标题：${doc.title}\n标签：${doc.tags.join(', ') || '无'}\n\n` +
          `笔记正文（节选）：\n${(doc.body || '').slice(0, 3000)}\n\n` +
          `请只返回 JSON：{"category":"建议的分类目录路径，如 sensors/驱动","tags":["建议标签"],"summary":"一句话摘要","keywords":["关键词"]}`,
      },
    ];
    const text = await this.chat(messages, { json: true, temperature: 0.3 });
    return this._safeJson(text);
  }

  async expandNote(doc, userPrompt) {
    const messages = [
      { role: 'system', content: this._system('嵌入式系统、Linux 驱动、计算机视觉、跟踪算法、充电桩等') },
      {
        role: 'user',
        content:
          `下面是知识库中的一篇笔记。请结合 ${userPrompt || '相关领域知识'} 对这篇笔记进行知识扩展补全。\n\n` +
          `要求：\n1. 在不改变原文的基础上，补充深化相关背景原理、常见坑、命令、进一步学习资料。\n` +
          `2. 返回纯 Markdown 内容（可直接追加到笔记末尾），用二级/三级标题组织，不要输出代码围栏包裹整个内容，不要复述原正文。\n\n` +
          `笔记标题：${doc.title}\n笔记正文：\n${(doc.body || '').slice(0, 6000)}\n\n` +
          `【扩展输出】`,
      },
    ];
    return this.chat(messages, { temperature: 0.7 });
  }

  async summarize(doc) {
    const messages = [
      { role: 'system', content: this._system() },
      {
        role: 'user',
        content:
          `请为下列笔记生成一份"一页纸复习摘要"，包含：重点原理、关键命令/API、易错点、快速复习要点、自测题（3题带答案）。输出为清晰的 Markdown。\n\n` +
          `笔记标题：${doc.title}\n笔记正文：\n${(doc.body || '').slice(0, 8000)}\n\n## 复习摘要`,
      },
    ];
    return this.chat(messages, { temperature: 0.4 });
  }

  async quiz(notes, { count = 5 } = {}) {
    const joined = notes
      .map((n) => `【${n.title}】(标签:${(n.tags || []).join(',') || '无'})\n${(n.body || '').slice(0, 1500)}`)
      .join('\n\n');
    const messages = [
      { role: 'system', content: this._system() },
      {
        role: 'user',
        content:
          `请根据以下笔记生成 ${count} 道复习自测题，难度适中，覆盖概念、原理、实操命令，每题给出答案要点。输出 Markdown，格式：\n` +
          `## Q1 题目\n答案：…\n\n笔记内容：\n${joined.slice(0, 12000)}`,
      },
    ];
    return this.chat(messages, { temperature: 0.5 });
  }

  async quickChat(notes, question) {
    const joined = notes
      .map((n) => `【来源 ${n.relPath}】\n${(n.body || '').slice(0, 2500)}`)
      .join('\n\n');
    const messages = [
      { role: 'system', content: this._system('嵌入式/驱动/算法/无人机') },
      {
        role: 'user',
        content:
          `基于以下知识库笔记回答用户问题。引用时标注笔记来源。若笔记信息不足，诚实说明并给出搜索建议；不要编造。\n\n` +
          `【知识库笔记】\n${joined.slice(0, 24000)}\n\n【用户问题】${question}\n\n## 回答`,
      },
    ];
    return this.chat(messages, { temperature: 0.3 });
  }

  // v1.2: 批量归类分析——分析全库笔记，生成分类调整建议报告
  async batchClassify(docs, { batchSize = 20 } = {}) {
    const summaries = docs.map((d) => ({
      relPath: d.relPath,
      title: d.title,
      tags: d.tags,
      body: (d.body || '').slice(0, 800),
    }));
    const batches = [];
    for (let i = 0; i < summaries.length; i += batchSize) {
      batches.push(summaries.slice(i, i + batchSize));
    }
    const results = [];
    for (const batch of batches) {
      const list = batch.map((d) => `- ${d.relPath} | 标题: ${d.title} | 标签: ${d.tags.join(', ') || '无'}\n  摘要: ${d.body.slice(0, 200)}`).join('\n');
      const messages = [
        { role: 'system', content: this._system() },
        {
          role: 'user',
          content:
            `请分析以下笔记列表，为每篇笔记给出分类建议。要求返回 JSON 数组，每个元素：\n` +
            `{"relPath":"原路径","suggestedCategory":"建议分类目录","suggestedTags":["建议标签"],"reason":"简要理由"}\n\n` +
            `笔记列表：\n${list}\n\n返回 JSON 数组：`,
        },
      ];
      const text = await this.chat(messages, { json: true, temperature: 0.3 });
      const parsed = this._safeJsonArray(text);
      results.push(...parsed);
    }
    return results;
  }

  _safeJsonArray(text) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) return arr;
    } catch {}
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr)) return arr;
      } catch {}
    }
    return [];
  }

  _safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {
          /* ignore */
        }
      }
      return { category: '', tags: [], summary: text.slice(0, 200), keywords: [] };
    }
  }
}

module.exports = { DeepSeekAI, AIError };