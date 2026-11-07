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
        return '<span class="math-block" data-latex="' + escapeHtml(latex) + '">' + global.katex.renderToString(latex, { displayMode: true, throwOnError: false, strict: false }) + '</span>';
      } catch (e) {
        /* fall through */
      }
    }
    return '<pre class="math-fallback">' + escapeHtml(latex) + '</pre>';
  }

  function renderInlineMath(latex) {
    if (global.katex) {
      try {
        return '<span class="math-inline" data-latex="' + escapeHtml(latex) + '">' + global.katex.renderToString(latex, { throwOnError: false, strict: false }) + '</span>';
      } catch (e) {
        return '<span class="math-fallback">' + escapeHtml(latex) + '</span>';
      }
    }
    return '<code class="math-fallback">' + escapeHtml(latex) + '</code>';
  }

  function unescapeAttr(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }

  // 双转义公式内容规范化：\\\\frac → \frac（双转义命令），\\\\\\\\ → \\\\（双转义换行）；
  // 单反斜杠换行 \\ 后跟换行/空格/& 等的合法用法保留不动（与 app.js splitMathParts 同款）
  function normalizeLatex(s) {
    return s
      .replace(/\\\\\\\\/g, '\\\\')
      .replace(/\\\\([a-zA-Z])/g, '\\$1')
      // markdown 转义的括号/下标还原（KaTeX 中 \[ \] \_ 会报错或显示为字面量）；
      // 保留 \\[0.5em] 这类行尾间距参数
      .replace(/\\+\[(?!\s*[\d.]+(?:em|ex|px|pt|cm|mm|in)\])/g, '[')
      .replace(/\\+\]/g, ']')
      .replace(/\\+_/g, '_')
      // 行尾/末尾孤立反斜杠（KaTeX 报错）
      .replace(/\\+[\s]*$/, '');
  }

  // 裸公式行识别：无 $ 定界符但明显是 LaTeX 公式（AI 生成/外部文档常见）
  // 如 "Alt(u) = Alt\_{low} + ... \frac{...}{...}"
  const STRONG_MATH_CMD = /\\(frac|cdot|times|div|sqrt|sum|prod|int|lim|cos|sin|tan|sec|csc|cot|arcsin|arccos|arctan|ln|log|exp|pi|alpha|beta|gamma|delta|Delta|theta|varphi|phi|lambda|mu|nu|rho|sigma|tau|omega|infty|left|right|quad|qquad|begin|end|leq|geq|neq|approx|equiv|partial|nabla|mathbb|mathrm|operatorname|overline|hat|vec|subset|supset|cup|cap|land|lor|forall|exists)\b/;
  const CJK_RE = /[一-鿿　-〿＀-￯]/;
  function bareEquationLine(t) {
    if (!t || t.indexOf('$') !== -1 || t.indexOf('`') !== -1) return false;
    if (CJK_RE.test(t)) return false;
    if (t.indexOf('=') === -1) return false;
    if (/^[ \t]*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|---\s*$)/.test(t)) return false; // markdown 结构行
    return STRONG_MATH_CMD.test(t) || /[_^]\\?\{/.test(t);
  }
  // 残缺 $$（只有结尾没有开头，外部/AI 文档常见）；行首 $ 开头的错配交由 inline() 的 caseC 处理
  function oddDollarLine(t) {
    if (!t || t[0] === '$' || (t.match(/\$\$/g) || []).length % 2 !== 1) return false;
    if (t.indexOf('`') !== -1 || CJK_RE.test(t)) return false;
    if (/^[ \t]*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|---\s*$)/.test(t)) return false;
    return STRONG_MATH_CMD.test(t) || /[_^]\\?\{/.test(t);
  }

  function inline(src) {
    let s = src;
    // 缓存已渲染的 HTML（公式 / 行内代码），占位符在所有格式规则执行完后最后恢复，
    // 防止 ^ → <sup> 等规则误伤公式内容（如 $E=mc^2$）
    const mathCache = [];
    const ph = (i) => '\u0000KX' + i + '\u0000';

    // 1. 兼容旧版编辑器保存的公式 HTML 节点（须在转义处理之前，保留 latex 属性原样）
    s = s.replace(/<div\b[^>]*\bdata-block-math\b[^>]*><\/div>/g, (m) => {
      const am = m.match(/\blatex="([^"]*)"/);
      if (!am || !am[1]) return m;
      mathCache.push(renderBlockMath(unescapeAttr(am[1])));
      return ph(mathCache.length - 1);
    });
    s = s.replace(/<span\b[^>]*\bdata-inline-math\b[^>]*><\/span>/g, (m) => {
      const am = m.match(/\blatex="([^"]*)"/);
      if (!am || !am[1]) return m;
      mathCache.push(renderInlineMath(unescapeAttr(am[1])));
      return ph(mathCache.length - 1);
    });

    // 2. 行内代码优先提取：保护其中的 $、\\ 等不被公式提取与转义规则误伤
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      mathCache.push('<code>' + escapeHtml(c) + '</code>');
      return ph(mathCache.length - 1);
    });

    // 3. 数学公式提取（在 \\ 转义之前，避免破坏 aligned 内合法 \\ 换行与双转义公式）。
    //    支持 $..$、$$..$$、\(..\)、\[..\] 及外部文档常见双转义 \\(..\\)、\\[..\\]、\$..\$
    const isCurrency = (inner) => /^\s|\s$/.test(inner) || /^[\d.,\s]+$/.test(inner);
    // 单开双闭错配 $..\$\$（外部/AI 生成文档常见），须在常规 $..$ 之前处理
    s = s.replace(/\$([^$\n]+?)\$\$(?=\s|$)/g, (m0, a) => {
      if (isCurrency(a)) return m0;
      mathCache.push(renderInlineMath(normalizeLatex(a.trim())));
      return ph(mathCache.length - 1);
    });
    s = s.replace(/\$\$([\s\S]+?)\$\$|\\+\[([\s\S]+?)\\+\]|\\+\(([\s\S]+?)\\+\)|\\+\$([^$\n]+?)\\+\$|\$([^$\n]+?)\$/g, (m0, a, b, c, d, e) => {
      let latex = null;
      let block = false;
      if (a !== undefined) { latex = normalizeLatex(a.trim()); block = true; }
      else if (b !== undefined) { latex = normalizeLatex(b.trim()); block = true; }
      else if (c !== undefined) { latex = normalizeLatex(c.trim()); }
      else {
        // d = \$..\$，e = $..$：货币等误伤保护（$5、$10 等不是公式）
        const inner = d !== undefined ? d : e;
        if (isCurrency(inner)) return m0;
        latex = normalizeLatex(inner.trim());
      }
      if (!latex) return m0;
      mathCache.push(block ? renderBlockMath(latex) : renderInlineMath(latex));
      return ph(mathCache.length - 1);
    });

    // 4. Markdown 转义序列（Vditor 将 $$ 存为 \$ 和 \\）——只作用于剩余非公式/非代码文本
    s = s.replace(/\\\\/g, '\\');
    s = s.replace(/\\\$/g, '$');

    // 5. HTML 转义（不影响已提取的占位符）
    s = escapeHtml(s);

    // 6. 其余格式规则（图片/链接/加粗/上下标等），占位符不含特殊字符不会被误伤
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]+)&quot;)?\)/g, '<img alt="$1" src="$2" title="$3" style="max-width:100%">');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]+)&quot;)?\)/g, '<a href="$2" title="$3" target="_blank">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\^([^^]+)\^/g, '<sup>$1</sup>');

    // 7. 最后恢复公式与行内代码
    if (mathCache.length) {
      s = s.replace(/\u0000KX(\d+)\u0000/g, (_, n) => mathCache[+n]);
    }

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
    // 段落逐行处理：裸公式行 / 残缺 $$ 行 → 独立块级公式；其余行合并为普通段落
    function paraLines(lines) {
      let out = '';
      let buf = [];
      const flush = () => {
        if (buf.length) { out += '<p>' + inline(buf.join(' ')) + '</p>\n'; buf = []; }
      };
      for (const ln of lines) {
        const t = ln.trim();
        if (bareEquationLine(t)) {
          flush();
          out += renderBlockMath(normalizeLatex(t)) + '\n';
        } else if (oddDollarLine(t)) {
          flush();
          out += renderBlockMath(normalizeLatex(t.replace(/\$\$/g, '').trim())) + '\n';
        } else {
          buf.push(ln);
        }
      }
      flush();
      return out;
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

      // 数学块：单行 $$...$$ / \[...\]（含双转义 \\[..\\]）
      let mBlock = line.match(/^\s*\$\$(.+?)\$\$\s*$/);
      if (mBlock) {
        html += renderBlockMath(normalizeLatex(mBlock[1].trim())) + '\n';
        i++;
        continue;
      }
      mBlock = line.match(/^\s*\\+\[(.+?)\\+\]\s*$/);
      if (mBlock) {
        html += renderBlockMath(normalizeLatex(mBlock[1].trim())) + '\n';
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
      const blockOpen = line.match(/^\s*(\$\$|\\+\[)/);
      if (blockOpen) {
        const isDollar = blockOpen[1] === '$$';
        const closeRe = isDollar ? /\$\$/ : /\\+\]/;
        const buf = [];
        let body = line.replace(/^\s*\$\$\s*/, '').replace(/^\s*\\+\[\s*/, '');
        if (body && closeRe.test(body)) {
          body = body.replace(/\$\$\s*$/, '').replace(/\\+\]\s*$/, '');
          html += renderBlockMath(normalizeLatex(body.trim())) + '\n';
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
        html += renderBlockMath(normalizeLatex(buf.join('\n'))) + '\n';
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
        !/^\s*\\+\[/.test(lines[i]) &&
        !isTableStart(i) &&
        !/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      html += paraLines(buf) + '\n';
    }
    return html;
  }

  global.renderMarkdown = (src) => {
    headingSeq = 0;
    return render(src);
  };
})(typeof window !== 'undefined' ? window : globalThis);
