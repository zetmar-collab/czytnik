// Konwersja EPUB i MOBI/AZW3 do TXT, Markdown, DOCX i PDF.
// Książka jest najpierw sprowadzana do prostej listy bloków (nagłówki, akapity, punkty listy, obrazy),
// a z niej powstają formaty docelowe. DOCX jest składany ręcznie (ZIP z WordprocessingML), a PDF
// drukuje proces główny (printToPDF) z wygenerowanego HTML-a — bez dodatkowych zależności.
const fsp = require('fs/promises');
const path = require('path');
const cheerio = require('cheerio');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const FORMATS = { txt: 'txt', md: 'md', docx: 'docx', pdf: 'pdf' };
const MAX_BYTES = 300 * 1024 * 1024;
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'tr', 'section', 'article',
  'ul', 'ol', 'table', 'tbody', 'dd', 'dt', 'dl', 'figure', 'figcaption', 'body', 'aside', 'header', 'footer', 'hr', 'center']);
const LEAF_ONLY = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'pre', 'dd', 'dt', 'figcaption']);
const SKIP = new Set(['script', 'style', 'head', 'nav', 'title']);
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

// ---------- HTML -> bloki ----------

// Zbiera tekst z formatowaniem (pogrubienie/kursywa/link) z węzła i jego potomków.
function inlineRuns(node, fmt, out) {
  if (node.type === 'text') {
    const t = String(node.data || '').replace(/\s+/g, ' ');
    if (t) out.push({ t, b: !!fmt.b, i: !!fmt.i, href: fmt.href || null });
  } else if (node.type === 'tag') {
    const n = node.name.toLowerCase();
    if (SKIP.has(n)) return;
    if (n === 'br') { out.push({ t: '\n', b: false, i: false, href: null }); return; }
    if (n === 'img') return;
    const f = { ...fmt };
    if (n === 'b' || n === 'strong') f.b = true;
    if (n === 'i' || n === 'em' || n === 'cite') f.i = true;
    if (n === 'a' && node.attribs?.href && /^https?:/i.test(node.attribs.href)) f.href = node.attribs.href;
    for (const c of node.children || []) inlineRuns(c, f, out);
  }
}

function trimRuns(runs) {
  const out = runs.filter((r) => r.t !== '');
  while (out.length && out[0].t !== '\n' && !out[0].t.trim()) out.shift();
  while (out.length && !out[out.length - 1].t.trim()) out.pop();
  if (out.length) { out[0] = { ...out[0], t: out[0].t.replace(/^\s+/, '') }; const l = out.length - 1; out[l] = { ...out[l], t: out[l].t.replace(/\s+$/, '') }; }
  return out;
}

function htmlToBlocks(html, $$ = cheerio, images = null) {
  const $ = $$.load(html);
  const blocks = [];
  let pending = [];
  const flush = () => {
    const runs = trimRuns(pending);
    pending = [];
    if (runs.length && runs.some((r) => r.t.trim())) blocks.push({ t: 'p', runs });
  };
  const hasBlockChild = (node) => (node.children || []).some((c) => c.type === 'tag' && (BLOCK.has(c.name.toLowerCase()) || hasBlockChild(c)));

  const walk = (node, ordered = null) => {
    if (node.type === 'text') { inlineRuns(node, {}, pending); return; }
    if (node.type !== 'tag') return;
    const n = node.name.toLowerCase();
    if (SKIP.has(n)) return;
    if (n === 'img') {
      flush();
      const src = node.attribs?.src;
      const img = src && images ? images(src) : null;
      if (img) blocks.push({ t: 'img', ...img });
      return;
    }
    if (!BLOCK.has(n)) { inlineRuns(node, {}, pending); return; }
    flush();
    if (n === 'hr') return;
    if (/^h[1-6]$/.test(n)) {
      const runs = []; inlineRuns(node, {}, runs);
      const r = trimRuns(runs);
      if (r.length) blocks.push({ t: 'h', l: Number(n[1]), runs: r });
      for (const im of $(node).find('img').toArray()) walk(im);
      return;
    }
    if (n === 'li') {
      const runs = []; inlineRuns(node, {}, runs);
      const r = trimRuns(runs);
      if (r.length) blocks.push({ t: 'li', runs: r, ordered: ordered !== null });
      return;
    }
    if (LEAF_ONLY.has(n) || !hasBlockChild(node)) {
      for (const c of node.children || []) walk(c);
      flush();
      return;
    }
    let idx = 0;
    for (const c of node.children || []) walk(c, n === 'ol' ? ++idx : (n === 'ul' ? null : ordered));
    flush();
  };

  const body = $('body').get(0) || $.root().get(0);
  for (const c of body.children || []) walk(c);
  flush();
  return blocks;
}

// ---------- źródła: EPUB i MOBI ----------

async function epubBlocks(file, { withImages }) {
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const container = xml.parse(await zip.file('META-INF/container.xml').async('string'));
  const opfPath = asArray(container?.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
  const opf = xml.parse(await zip.file(opfPath).async('string'))?.package;
  const dir = path.posix.dirname(opfPath);
  const manifest = new Map(asArray(opf?.manifest?.item).map((i) => [i['@_id'], i]));
  const blocks = [];
  let imageBytes = 0;
  for (const ref of asArray(opf?.spine?.itemref)) {
    const item = manifest.get(ref['@_idref']);
    if (!item || !/x?html|xml/.test(item['@_media-type'] || '')) continue;
    const href = decodeURIComponent(item['@_href']);
    const name = dir === '.' ? href : path.posix.join(dir, href);
    const entry = zip.file(name);
    if (!entry) continue;
    const html = await entry.async('string');
    const base = path.posix.dirname(name);
    const imgs = new Map();
    if (withImages) {
      const $ = cheerio.load(html);
      for (const el of $('img').toArray()) {
        const src = el.attribs?.src;
        if (!src || /^(data:|https?:)/i.test(src) || imgs.has(src)) continue;
        const f = zip.file(path.posix.normalize(path.posix.join(base, decodeURIComponent(src.split('#')[0]))));
        if (!f) continue;
        const ext = path.extname(src).toLowerCase();
        const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
        if (!mime) continue;
        const buf = await f.async('nodebuffer');
        imageBytes += buf.length;
        if (imageBytes > 120 * 1024 * 1024) continue; // ogranicz rozmiar wynikowego pliku
        imgs.set(src, { mime, data: buf });
      }
    }
    const part = htmlToBlocks(html, cheerio, (src) => imgs.get(src) || null);
    if (part.length) blocks.push(...part, { t: 'sep' });
  }
  return blocks;
}

async function mobiBlocks(file) {
  const html = await require('./fulltext').mobiHtml(file);
  if (html == null) throw new Error('Ten plik MOBI używa nieobsługiwanej kompresji (HUFF/CDIC) — konwersja niemożliwa');
  // PalmDOC zawiera znaczniki <mbp:pagebreak/> — zamieniamy je na separatory rozdziałów
  const parts = html.split(/<mbp:pagebreak\s*\/?>/i);
  const blocks = [];
  for (const part of parts) {
    const b = htmlToBlocks(part);
    if (b.length) blocks.push(...b, { t: 'sep' });
  }
  return blocks;
}

async function loadBook(book, { withImages = false } = {}) {
  const st = await fsp.stat(book.path);
  if (st.size > MAX_BYTES) throw new Error('Plik jest zbyt duży do konwersji');
  let blocks;
  if (book.format === 'epub') blocks = await epubBlocks(book.path, { withImages });
  else if (book.format === 'mobi' || book.format === 'azw3') blocks = await mobiBlocks(book.path);
  else throw new Error('Konwersja obsługuje tylko EPUB, MOBI i AZW3');
  while (blocks.length && blocks[blocks.length - 1].t === 'sep') blocks.pop();
  if (!blocks.some((b) => b.t !== 'sep' && b.t !== 'img')) throw new Error('Nie znaleziono tekstu do konwersji (książka może być chroniona DRM)');
  return { title: book.title || path.basename(book.path, path.extname(book.path)), author: book.author || '', blocks };
}

// ---------- TXT ----------

const plain = (runs) => runs.map((r) => r.t).join('');

function renderTxt(doc) {
  const out = [doc.title, doc.author].filter(Boolean);
  out.push('', '');
  for (const b of doc.blocks) {
    if (b.t === 'sep') out.push('', '* * *', '');
    else if (b.t === 'h') out.push('', b.l <= 2 ? plain(b.runs).toUpperCase() : plain(b.runs), '');
    else if (b.t === 'li') out.push('  • ' + plain(b.runs));
    else if (b.t === 'p') out.push(plain(b.runs), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------- Markdown ----------

const mdEsc = (s) => s.replace(/([\\`*_[\]<>])/g, '\\$1');

function mdRuns(runs) {
  return runs.map((r) => {
    if (r.t === '\n') return '  \n';
    let t = mdEsc(r.t);
    const lead = /^\s*/.exec(t)[0];
    const trail = /\s*$/.exec(t)[0];
    let core = t.trim();
    if (!core) return t;
    if (r.b && r.i) core = `***${core}***`; else if (r.b) core = `**${core}**`; else if (r.i) core = `*${core}*`;
    if (r.href) core = `[${core}](${r.href})`;
    return lead + core + trail;
  }).join('');
}

function renderMd(doc) {
  const out = [`# ${mdEsc(doc.title)}`, ''];
  if (doc.author) out.push(`*${mdEsc(doc.author)}*`, '');
  let n = 0;
  let prevLi = false;
  for (const b of doc.blocks) {
    if (b.t === 'li') { n = prevLi ? n + 1 : 1; out.push(`${b.ordered ? n + '.' : '-'} ${mdRuns(b.runs)}`); prevLi = true; continue; }
    if (prevLi) out.push('');
    prevLi = false;
    if (b.t === 'sep') out.push('---', '');
    else if (b.t === 'h') out.push(`${'#'.repeat(Math.min(6, b.l + 1))} ${mdRuns(b.runs).replace(/\*+/g, '')}`, '');
    else if (b.t === 'p') out.push(mdRuns(b.runs), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------- DOCX ----------

// znaki niedozwolone w XML 1.0
const xmlClean = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const xmlEsc = (s) => xmlClean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function docxRuns(runs, extraProps = '') {
  return runs.map((r) => {
    if (r.t === '\n') return '<w:r><w:br/></w:r>';
    const props = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + extraProps;
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(r.t)}</w:t></w:r>`;
  }).join('');
}

const para = (style, inner) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${inner}</w:p>`;

function renderDocxXml(doc) {
  const body = [para('Title', docxRuns([{ t: doc.title }]))];
  if (doc.author) body.push(para('Subtitle', docxRuns([{ t: doc.author }])));
  let n = 0;
  let prevLi = false;
  for (const b of doc.blocks) {
    if (b.t === 'li') {
      n = prevLi ? n + 1 : 1;
      body.push(para('ListParagraph', docxRuns([{ t: b.ordered ? `${n}. ` : '• ' }, ...b.runs])));
      prevLi = true;
      continue;
    }
    prevLi = false;
    if (b.t === 'sep') body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else if (b.t === 'h') body.push(para(`Heading${Math.min(3, b.l)}`, docxRuns(b.runs)));
    else if (b.t === 'p') body.push(para('Normal', docxRuns(b.runs)));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="23"/><w:lang w:val="pl-PL"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="1200" w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="600"/></w:pPr><w:rPr><w:i/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="left"/><w:spacing w:before="480" w:after="200"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="left"/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="left"/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/><w:jc w:val="left"/></w:pPr></w:style>
</w:styles>`;

async function renderDocx(doc) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEsc(doc.title)}</dc:title><dc:creator>${xmlEsc(doc.author || '')}</dc:creator></cp:coreProperties>`);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/document.xml', renderDocxXml(doc));
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ---------- HTML (do wydruku PDF) ----------

const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const htmlRuns = (runs) => runs.map((r) => {
  if (r.t === '\n') return '<br>';
  let t = htmlEsc(r.t);
  if (r.b) t = `<b>${t}</b>`;
  if (r.i) t = `<i>${t}</i>`;
  return t;
}).join('');

function renderHtml(doc) {
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const b of doc.blocks) {
    if (b.t === 'li') {
      const want = b.ordered ? 'ol' : 'ul';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${htmlRuns(b.runs)}</li>`);
      continue;
    }
    closeList();
    if (b.t === 'sep') out.push('<div class="sep"></div>');
    else if (b.t === 'h') out.push(`<h${Math.min(4, b.l)}>${htmlRuns(b.runs)}</h${Math.min(4, b.l)}>`);
    else if (b.t === 'p') out.push(`<p>${htmlRuns(b.runs)}</p>`);
    else if (b.t === 'img') out.push(`<p class="img"><img src="data:${b.mime};base64,${b.data.toString('base64')}"></p>`);
  }
  closeList();
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>${htmlEsc(doc.title)}</title><style>
body{font-family:Georgia,'Times New Roman',serif;font-size:11.5pt;line-height:1.5;color:#000}
h1{font-size:20pt;margin:1.2em 0 .5em;page-break-after:avoid} h2{font-size:16pt;page-break-after:avoid} h3,h4{font-size:13pt;page-break-after:avoid}
p{margin:0 0 .6em;text-align:justify;orphans:2;widows:2} .sep{page-break-after:always} li{margin-bottom:.3em}
.cover{text-align:center;margin-top:30vh;page-break-after:always} .cover h1{font-size:28pt} .cover p{font-size:14pt;text-align:center;font-style:italic}
img{max-width:100%;max-height:22cm} .img{text-align:center}
</style></head><body><div class="cover"><h1>${htmlEsc(doc.title)}</h1>${doc.author ? `<p>${htmlEsc(doc.author)}</p>` : ''}</div>${out.join('\n')}</body></html>`;
}

// ---------- API ----------

function safeName(s) {
  return String(s || 'ksiazka').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'ksiazka';
}

function defaultFileName(book, format) {
  return `${safeName([book.author, book.title].filter(Boolean).join(' - '))}.${format}`;
}

// printPdf(htmlFilePath, outFile) dostarcza proces główny (potrzebuje Electrona).
async function convertBook(book, format, outFile, { printPdf, tmpDir } = {}) {
  if (!FORMATS[format]) throw new Error('Nieobsługiwany format docelowy');
  const doc = await loadBook(book, { withImages: format === 'pdf' });
  if (format === 'txt') await fsp.writeFile(outFile, '﻿' + renderTxt(doc), 'utf8');
  else if (format === 'md') await fsp.writeFile(outFile, renderMd(doc), 'utf8');
  else if (format === 'docx') await fsp.writeFile(outFile, await renderDocx(doc));
  else {
    if (!printPdf) throw new Error('Eksport PDF nie jest dostępny w tym środowisku');
    const tmp = path.join(tmpDir, `czytnik-pdf-${process.pid}-${Date.now()}.html`);
    await fsp.writeFile(tmp, renderHtml(doc), 'utf8');
    try { await printPdf(tmp, outFile); } finally { fsp.rm(tmp, { force: true }).catch(() => {}); }
  }
  return outFile;
}

module.exports = { FORMATS, loadBook, convertBook, defaultFileName, safeName, htmlToBlocks, renderTxt, renderMd, renderDocx, renderHtml, renderDocxXml };
