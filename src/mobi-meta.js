// Parser metadanych MOBI / AZW3 (PalmDB + nagłówek MOBI + rekordy EXTH).
// Wyciąga tytuł, autora, opis, wydawcę, ISBN, rok oraz okładkę.

function decodeText(buf, encoding) {
  try {
    if (encoding === 65001) return buf.toString('utf8');
    return buf.toString('latin1');
  } catch {
    return buf.toString('latin1');
  }
}

function parseMobi(buf) {
  if (buf.length < 80) return null;
  const numRecords = buf.readUInt16BE(76);
  if (buf.length < 78 + numRecords * 8) return null;
  const offsets = [];
  for (let i = 0; i < numRecords; i++) offsets.push(buf.readUInt32BE(78 + i * 8));
  const r0 = offsets[0];
  if (r0 + 132 > buf.length) return null;
  if (buf.toString('latin1', r0 + 16, r0 + 20) !== 'MOBI') return null;

  const mobiLen = buf.readUInt32BE(r0 + 20);
  const encoding = buf.readUInt32BE(r0 + 28);
  const meta = {};

  // pełny tytuł
  try {
    const titleOff = buf.readUInt32BE(r0 + 84);
    const titleLen = buf.readUInt32BE(r0 + 88);
    if (titleLen > 0 && titleLen < 2048 && r0 + titleOff + titleLen <= buf.length) {
      meta.title = decodeText(buf.slice(r0 + titleOff, r0 + titleOff + titleLen), encoding).trim();
    }
  } catch { /* ignoruj */ }

  // indeks pierwszego rekordu z obrazem (do okładki)
  let firstImage = null;
  if (mobiLen >= 0x70) {
    const v = buf.readUInt32BE(r0 + 108);
    if (v > 0 && v < numRecords) firstImage = v;
  }

  // rekordy EXTH
  let coverOffset = null;
  const exthFlag = mobiLen >= 0x74 ? buf.readUInt32BE(r0 + 128) : 0;
  if (exthFlag & 0x40) {
    let p = r0 + 16 + mobiLen;
    if (buf.toString('latin1', p, p + 4) === 'EXTH') {
      const count = buf.readUInt32BE(p + 8);
      p += 12;
      for (let i = 0; i < count && p + 8 <= buf.length; i++) {
        const type = buf.readUInt32BE(p);
        const len = buf.readUInt32BE(p + 4);
        if (len < 8 || p + len > buf.length) break;
        const data = buf.slice(p + 8, p + len);
        switch (type) {
          case 100: if (!meta.author) meta.author = decodeText(data, encoding).trim(); break;
          case 101: meta.publisher = decodeText(data, encoding).trim(); break;
          case 103: meta.description = decodeText(data, encoding).trim(); break;
          case 104: meta.isbn = decodeText(data, encoding).replace(/[^0-9Xx-]/g, '').trim(); break;
          case 106: {
            const m = decodeText(data, encoding).match(/\d{4}/);
            if (m) meta.year = m[0];
            break;
          }
          case 503: meta.title = decodeText(data, encoding).trim(); break;
          case 201: if (data.length >= 4) coverOffset = data.readUInt32BE(0); break;
        }
        p += len;
      }
    }
  }

  // okładka
  if (firstImage != null && coverOffset != null && coverOffset !== 0xffffffff) {
    const idx = firstImage + coverOffset;
    if (idx < numRecords) {
      const start = offsets[idx];
      const end = idx + 1 < numRecords ? offsets[idx + 1] : buf.length;
      const img = buf.slice(start, end);
      if (img.length > 100) {
        let ext = null;
        if (img[0] === 0xff && img[1] === 0xd8) ext = 'jpg';
        else if (img[0] === 0x89 && img[1] === 0x50) ext = 'png';
        else if (img[0] === 0x47 && img[1] === 0x49) ext = 'gif';
        if (ext) meta.coverBuf = img, meta.coverExt = ext;
      }
    }
  }

  return meta;
}

module.exports = { parseMobi };
