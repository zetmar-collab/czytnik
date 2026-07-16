// Tworzy przykładowe pliki do testów: EPUB i PDF w test/biblioteka/.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const dir = path.join(__dirname, 'biblioteka');
fs.mkdirSync(dir, { recursive: true });

async function makeEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  // 1x1 czerwony PNG jako okładka
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  zip.file('OEBPS/cover.png', png);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:isbn:9788373271500</dc:identifier>
    <dc:title>Lalka</dc:title>
    <dc:creator>Bolesław Prus</dc:creator>
    <dc:language>pl</dc:language>
    <dc:publisher>Testowe Wydawnictwo</dc:publisher>
    <dc:date>1890-01-01</dc:date>
    <dc:description>Powieść testowa do sprawdzenia czytnika.</dc:description>
    <meta name="cover" content="cover"/>
  </metadata>
  <manifest>
    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`);
  const para = 'Było to wczesnym rankiem, gdy Stanisław Wokulski wracał z Bułgarii z majątkiem zdobytym na dostawach wojennych. '.repeat(8);
  const chapter = (n, title) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1>${Array.from({ length: 15 }, (_, i) => `<p>${i + 1}. ${para}</p>`).join('\n')}</body></html>`;
  zip.file('OEBPS/ch1.xhtml', chapter(1, 'Rozdział I'));
  zip.file('OEBPS/ch2.xhtml', chapter(2, 'Rozdział II'));
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Spis</title></head>
<body><nav epub:type="toc"><ol>
<li><a href="ch1.xhtml">Rozdział I</a></li>
<li><a href="ch2.xhtml">Rozdział II</a></li>
</ol></nav></body></html>`);
  const buf = await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' });
  fs.writeFileSync(path.join(dir, 'Boleslaw_Prus-Lalka.epub'), buf);
  console.log('EPUB zapisany');
}

function makePdf() {
  const lines = [];
  const pages = 3;
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    const contentId = 4 + i * 2;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> >>`);
    const text = `BT /F1 24 Tf 72 760 Td (Strona ${i + 1} - test PDF) Tj ET`;
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  fs.writeFileSync(path.join(dir, 'Testowy_dokument.pdf'), pdf, 'latin1');
  console.log('PDF zapisany');
}

makeEpub().then(makePdf);
