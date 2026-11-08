// Cognote 官网交互：移动端菜单 / 代码复制 / 目录高亮
(function () {
  // 移动端导航
  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () { links.classList.toggle('open'); });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') links.classList.remove('open');
    });
  }

  // pre 代码块复制按钮
  document.querySelectorAll('pre').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.addEventListener('click', function () {
      var text = pre.innerText.replace(/\n复制$/, '');
      var done = function () {
        btn.textContent = '已复制 ✓';
        setTimeout(function () { btn.textContent = '复制'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
      } else { fallback(text, done); }
    });
    pre.appendChild(btn);
  });

  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  // 文档页 TOC 滚动高亮
  var toc = document.getElementById('toc');
  if (toc && 'IntersectionObserver' in window) {
    var tocLinks = Array.prototype.slice.call(toc.querySelectorAll('a'));
    var heads = tocLinks
      .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
      .filter(Boolean);
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        tocLinks.forEach(function (a) {
          a.style.background = a.getAttribute('href') === '#' + en.target.id ? 'var(--accent-soft)' : '';
          a.style.borderLeftColor = a.getAttribute('href') === '#' + en.target.id ? 'var(--accent)' : '';
        });
      });
    }, { rootMargin: '-72px 0px -70% 0px' });
    heads.forEach(function (h) { io.observe(h); });
  }
})();
