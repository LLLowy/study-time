/**
 * 精简版 Markdown 渲染器（够写学习笔记用）。
 * 同时支持浏览器（挂到 window.mdToHtml）和 Node（require 后测试）。
 *
 * 支持：# 标题、- / 1. 列表、> 引用、``` 代码块、`行内代码`、
 *        **加粗**、*斜体*、~~删除线~~、[链接](url)、![图片](url)、
 *        --- 分隔线、| 表格 |
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.mdToHtml = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function mdToHtml(src) {
    let text = String(src || '').replace(/\r\n/g, '\n');

    // 先把代码块摘出来，避免里面的 Markdown 记号被误解析
    const blocks = [];
    text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      blocks.push(`<pre><code data-lang="${esc(lang)}">${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return `\u0000B${blocks.length - 1}\u0000`;
    });

    // 整体转义，之后所有替换都只产生受控标签
    text = esc(text);

    const inline = (s) => s
      .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    const lines = text.split('\n');
    const out = [];
    let listType = null;
    const closeList = () => {
      if (listType) { out.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; }
    };
    const isBlock = (l) => /^\u0000B\d+\u0000$/.test(l.trim());
    const isList = (l) => /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l);

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      if (isBlock(line)) { closeList(); out.push(line.trim()); i += 1; continue; }

      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        closeList();
        const lv = m[1].length;
        out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
        i += 1; continue;
      }
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeList(); out.push('<hr>'); i += 1; continue; }
      if ((m = line.match(/^&gt;\s?(.*)$/))) {
        closeList();
        const buf = [m[1]];
        i += 1;
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^&gt;\s?/, '')); i += 1; }
        out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
        closeList();
        const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i += 1; }
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
          + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        let body = m[1];
        let cls = '';
        const cb = body.match(/^\[([ xX])\]\s*([\s\S]*)$/);
        if (cb) {
          const done = cb[1].toLowerCase() === 'x';
          cls = done ? ' class="md-task is-done"' : ' class="md-task"';
          body = `<input type="checkbox" disabled${done ? ' checked' : ''}> ${inline(cb[2])}`;
        } else {
          body = inline(body);
        }
        out.push(`<li${cls}>${body}</li>`);
        i += 1; continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push(`<li>${inline(m[1])}</li>`);
        i += 1; continue;
      }

      closeList();
      const buf = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i]) && !isList(lines[i])) {
        if (/^(#{1,6})\s+/.test(lines[i]) || /^&gt;\s?/.test(lines[i])) break;
        buf.push(lines[i]); i += 1;
      }
      out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }
    closeList();

    return out.join('\n').replace(/\u0000B(\d+)\u0000/g, (_m, idx) => blocks[Number(idx)]);
  }

  mdToHtml.escapeHtml = esc;
  return mdToHtml;
}));
