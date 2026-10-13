// Plain text from a Word file's main XML (used for big files instead of mammoth; see extract-worker.js).

// Paragraphs, tabs and line breaks from WordprocessingML; everything else (formatting) is dropped.
export function wordXmlText(xml) {
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[0] === '<w:tab/>') out += '\t';
    else out += m[0] === '<w:br/>' ? '\n' : '\n\n';
  }
  return out;
}
