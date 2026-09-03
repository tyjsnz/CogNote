/* 轻量 Markdown 渲染器（支持常用语法 + KaTeX 数学公式，用于本地预览） */
(function (global) {
  // 标题锚点序号：整篇文档内递增以保证唯一，递归渲染（引用块）时继续累加
  let headingSeq = 0;
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderBlockMath(latex) {
    if (global.katex) {
      try {
        return '<span class="math-block">' + global.katex.renderToString(latex, { displayMode: true, throwOnError: false, strict: false }) + '</span>';
      } catch (e) {
        /* fall through */
      }
    }
    return '<pre class="math-fallback">' + escapeHtml(latex) + '</pre>';
  }

  function renderInlineMath(latex) {
    if (global.katex) {
      try {
        return '<span class="math-inline">' + global.katex.renderToString(latex, { throwOnError: false, strict: false }) + '</span>';
      } catch (e) {
        return '<span class="math-fallback">' + escapeHtml(latex) + '</span>';
      }
    }
    return '<code class="math-fallback">' + escapeHtml(latex) + '</code>';
  }

  function inline(src) {
    let s = src;
    // 处理 Markdown 转义序列（Vditor 将 $$ 存为 \$ 和 \\）
    // \\  → \  先于数学公式 regex，保证 \rightarrow 等 LaTeX 命令正确
    s = s.replace(/\\\\/g, '\\');
    // \$  → $  使 Vditor 保存的 \$...\$ 能被数学公式 regex 正确匹配
    s = s.replace(/\\\$/g, '$');

    // 数学公式优先提取，防止 HTML 转义破坏 < > 等字符
    const mathCache = [];
    s = s.replace(/\$\$(.+?)\$\$/g, (_, m) => {
      mathCache.push(renderBlockMath(m));
      return '\u0000KX' + (mathCache.length - 1) + '\u0000';
    });
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => {
      mathCache.push(renderInlineMath(m));
      return '\u0000KX' + (mathCache.length - 1) + '\u0000';
    });
    s = s.replace(/\$([^\$\n]+?)\$/g, (_, m) => {
      mathCache.push(renderInlineMath(m));
      return '\u0000KX' + (mathCache.length - 1) + '\u0000';
    });

    // HTML 转义（不影响已提取的数学公式占位符）
    s = escapeHtml(s);

    // 恢复数学公式
    if (mathCache.length) {
      s = s.replace(/\u0000KX(\d+)\u0000/g, (_, n) => mathCache[+n]);
    }

    // 行内代码
    s = s.replace(/`([^`]+)`/g, (_, c) => '<code>' + escapeHtml(c) + '</code>');

    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]+)&quot;)?\)/g, '<img alt="$1" src="$2" title="$3" style="max-width:100%">');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]+)&quot;)?\)/g, '<a href="$2" title="$3" target="_blank">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\^([^^]+)\^/g, '<sup>$1</sup>');

    return s;
  }

  function render(src) {
    if (!src || !src.trim()) return '<p class="empty">（空笔记）</p>';
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;
    function para(text) {
      if (!text.trim()) return '';
      return '<p>' + inline(text) + '</p>';
    }
    // 判断第 idx 行是否为表格起始行（当前行含 | 且下一行为分隔行）
    function isTableStart(idx) {
      const l = lines[idx];
      return (
        !!l &&
        l.includes('|') &&
        idx + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[idx + 1]) &&
        lines[idx + 1].includes('-')
      );
    }

    while (i < lines.length) {
      const line = lines[i];

      // 数学块：单行 $$...$$ / \[...\]
      let mBlock = line.match(/^\s*\$\$(.+?)\$\$\s*$/);
      if (mBlock) {
        html += renderBlockMath(mBlock[1]) + '\n';
        i++;
        continue;
      }
      mBlock = line.match(/^\s*\\\[(.+?)\\\]\s*$/);
      if (mBlock) {
        html += renderBlockMath(mBlock[1]) + '\n';
        i++;
        continue;
      }

      // 代码块
      const fence = line.match(/^```([\w+-]*)/);
      if (fence) {
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        html += '<pre><code' + (lang ? ' class="lang-' + escapeHtml(lang) + '"' : '') + '>' + escapeHtml(buf.join('\n')) + '</code></pre>\n';
        continue;
      }

      // 多行数学块：以 $$ 或 \[ 开头的行，持续到 $$ 或 \] 为止
      const blockOpen = line.match(/^\s*(\$\$|\\\[)/);
      if (blockOpen) {
        const isDollar = blockOpen[1] === '$$';
        const closeRe = isDollar ? /\$\$/ : /\\\]/;
        const buf = [];
        let body = line.replace(/^\s*\$\$\s*/, '').replace(/^\s*\\\[\s*/, '');
        if (body && closeRe.test(body)) {
          body = body.replace(/\$\$\s*$/, '').replace(/\\\]\s*$/, '');
          html += renderBlockMath(body) + '\n';
          i++;
          continue;
        }
        if (body) buf.push(body);
        i++;
        while (i < lines.length) {
          if (closeRe.test(lines[i])) {
            const endLine = lines[i].replace(closeRe, '');
            if (endLine.trim()) buf.push(endLine);
            i++;
            break;
          }
          buf.push(lines[i]);
          i++;
        }
        html += renderBlockMath(buf.join('\n')) + '\n';
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lv = h[1].length;
        html += '<h' + lv + ' id="toc-' + headingSeq++ + '">' + inline(h[2]) + '</h' + lv + '>\n';
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        html += '<hr>\n';
        i++;
        continue;
      }

      // 表格
      if (isTableStart(i)) {
        const header = line.split('|').map((s) => s.trim()).filter((s, idx, arr) => !(idx === 0 && s === '') && !(idx === arr.length - 1 && s === ''));
        const aligns = lines[i + 1].split('|').map((s) => s.trim());
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|')) {
          rows.push(lines[i].split('|').map((s) => s.trim()).filter((s, idx, arr) => !(idx === 0 && s === '') && !(idx === arr.length - 1 && s === '')));
          i++;
        }
        let t = '<table><thead><tr>';
        header.forEach((cell, idx) => {
          const a = (aligns[idx + 1] || '').trim();
          const align = a.startsWith(':') && a.endsWith(':') ? ' center' : a.startsWith(':') ? ' left' : a.endsWith(':') ? ' right' : '';
          t += '<th style="text-align:' + (align.trim() || 'left') + '">' + inline(cell) + '</th>';
        });
        t += '</tr></thead><tbody>';
        for (const r of rows) {
          t += '<tr>';
          header.forEach((_, idx) => {
            t += '<td>' + inline(r[idx] || '') + '</td>';
          });
          t += '</tr>';
        }
        t += '</tbody></table>\n';
        html += t;
        continue;
      }

      // 列表（含嵌套）
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const listBuf = [];
        while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
          const lm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          listBuf.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /^\d+/.test(lm[2]), text: lm[3] });
          i++;
        }
        const stacks = []; // 每个栈项 {tag, indent}
        let listHtml = '';
        for (const item of listBuf) {
          while (stacks.length && stacks[stacks.length - 1].indent > item.indent) stacks.pop();
          if (stacks.length && stacks[stacks.length - 1].indent === item.indent) listHtml += '</li>';
          if (!stacks.length || stacks[stacks.length - 1].indent < item.indent) {
            const tag = item.ordered ? 'ol' : 'ul';
            const pad = ' '.repeat(stacks.length * 2);
            listHtml += '\n' + pad + '<' + tag + '><li>';
            stacks.push({ tag, indent: item.indent });
          } else {
            listHtml += '<li>';
          }
          listHtml += inline(item.text);
        }
        while (stacks.length) {
          listHtml += '</li></' + stacks.pop().tag + '>';
        }
        html += listHtml + '\n';
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html += '<blockquote>' + render(buf.join('\n')) + '</blockquote>\n';
        continue;
      }

      // 普通段落
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^```/.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^\s*\$\$/.test(lines[i]) &&
        !/^\s*\\\[/.test(lines[i]) &&
        !isTableStart(i) &&
        !/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      html += para(buf.join(' ')) + '\n';
    }
    return html;
  }

  global.renderMarkdown = (src) => {
    headingSeq = 0;
    return render(src);
  };
})(typeof window !== 'undefined' ? window : globalThis);
