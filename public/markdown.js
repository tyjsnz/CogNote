/* 轻量 Markdown 渲染器（支持常用语法，用于本地预览） */
(function (global) {
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(src) {
    let s = src;
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
      return '<p>' + inline(escapeHtml(text).replace(/^#{1,6}\s+/, '')) + '</p>';
    }

    while (i < lines.length) {
      const line = lines[i];

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

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lv = h[1].length;
        html += '<h' + lv + '>' + inline(escapeHtml(h[2])) + '</h' + lv + '>\n';
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
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
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
          t += '<th style="text-align:' + (align.trim() || 'left') + '">' + inline(escapeHtml(cell)) + '</th>';
        });
        t += '</tr></thead><tbody>';
        for (const r of rows) {
          t += '<tr>';
          header.forEach((_, idx) => {
            t += '<td>' + inline(escapeHtml(r[idx] || '')) + '</td>';
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
          listHtml += inline(escapeHtml(item.text));
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
        !/^\s*>\s?/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      html += para(buf.join(' ')) + '\n';
    }
    return html;
  }

  global.renderMarkdown = render;
})(typeof window !== 'undefined' ? window : globalThis);