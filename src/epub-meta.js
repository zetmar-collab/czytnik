// Ekstrakcja metadanych i okładki z plików EPUB (container.xml -> OPF).
const path = require('path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
});

function txt(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim() || null;
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return txt(v['#text']);
  return null;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

async function parseEpub(buf) {
  const zip = await JSZip.loadAsync(buf);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) return null;
  const container = parser.parse(await containerFile.async('string'));
  let rootfiles = container?.container?.rootfiles?.rootfile;
  rootfiles = asArray(rootfiles);
  const opfPath = rootfiles[0]?.['@_full-path'];
  if (!opfPath) return null;
  const opfFile = zip.file(opfPath);
  if (!opfFile) return null;
  const opf = parser.parse(await opfFile.async('string'));
  const pkg = opf?.package;
  const md = pkg?.metadata || {};

  const meta = {};
  meta.title = txt(md.title);
  const creators = asArray(md.creator).map(txt).filter(Boolean);
  if (creators.length) meta.author = creators.join(', ');
  meta.description = stripHtml(txt(md.description));
  meta.publisher = txt(md.publisher);
  const date = txt(md.date);
  if (date) {
    const m = date.match(/\d{4}/);
    if (m) meta.year = m[0];
  }
  for (const ident of asArray(md.identifier)) {
    const v = txt(ident);
    if (v && /^(97[89])?[\d-]{9,}[\dXx]$/.test(v.replace(/^urn:isbn:/i, ''))) {
      meta.isbn = v.replace(/^urn:isbn:/i, '');
      break;
    }
  }

  // okładka: manifest item z properties="cover-image" albo <meta name="cover" content="id">
  const items = asArray(pkg?.manifest?.item);
  let coverItem = items.find((i) => (i['@_properties'] || '').includes('cover-image'));
  if (!coverItem) {
    const coverMeta = asArray(md.meta).find((m) => m['@_name'] === 'cover');
    const coverId = coverMeta?.['@_content'];
    if (coverId) coverItem = items.find((i) => i['@_id'] === coverId);
  }
  if (!coverItem) {
    coverItem = items.find((i) => /cover/i.test(i['@_id'] || '') && /image/.test(i['@_media-type'] || ''));
  }
  if (coverItem?.['@_href']) {
    const opfDir = path.posix.dirname(opfPath.replace(/\\/g, '/'));
    let href = decodeURIComponent(coverItem['@_href']);
    const coverPath = opfDir === '.' ? href : path.posix.join(opfDir, href);
    const coverFile = zip.file(coverPath) || zip.file(href);
    if (coverFile) {
      const img = await coverFile.async('nodebuffer');
      if (img.length > 40) {
        const mt = coverItem['@_media-type'] || '';
        meta.coverBuf = img;
        meta.coverExt = mt.includes('png') ? 'png' : mt.includes('gif') ? 'gif' : 'jpg';
      }
    }
  }

  return meta;
}

function stripHtml(s) {
  if (!s) return s;
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { parseEpub };
