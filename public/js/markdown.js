// Tiny, safe markdown for chat bubbles: **bold**, *italic*, `code`, lists, links, line breaks.
// Everything is HTML-escaped first, so nothing in a message can inject markup.

const escape = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(s) {
  let out = escape(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,!?:;)'"]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  // Phone numbers people may need fast.
  out = out.replace(/\b(988|911|741741)\b(?![^<]*<\/a>)/g, (n) => `<a href="${n === '741741' ? 'sms:741741&amp;body=HOME' : `tel:${n}`}">${n}</a>`);
  return out;
}

export function renderMarkdown(text) {
  const lines = String(text || '').split('\n');
  const html = [];
  let list = null;
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) {
        closeList();
        html.push(`<${type}>`);
        list = type;
      }
      html.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) html.push(`<p><strong>${inline(heading[1])}</strong></p>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
    else if (html.length && html[html.length - 1] !== '<div class="gap"></div>') html.push('<div class="gap"></div>');
  }
  closeList();
  while (html[html.length - 1] === '<div class="gap"></div>') html.pop();
  return html.join('');
}

export { escape as escapeHtml };
