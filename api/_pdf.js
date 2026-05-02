const PDFDocument = require('pdfkit');

const MARGIN = 50;
const L = MARGIN;
const R = 595.28 - MARGIN; // A4 width minus right margin
const W = R - L;           // 495pt content width

function formatLength(min) {
  if (!min) return '';
  const m = Math.floor(min);
  const s = Math.round((min - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setlistTitle(setlist) {
  return [
    setlist.title    ? `"${setlist.title}"` : null,
    setlist.gig_name ?? null,
    setlist.gig_date ? String(setlist.gig_date).slice(0, 10) : null,
  ].filter(Boolean).join(' — ') || null;
}

function buildSetlistPdf(setlist, songs, bandName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Courier-Bold').fontSize(15)
       .text(bandName || 'Setlist', L, doc.y, { width: W, align: 'center' });
    doc.moveDown(0.3);

    const title = setlistTitle(setlist);
    if (title) {
      doc.font('Courier').fontSize(10)
         .text(title, L, doc.y, { width: W, align: 'center' });
      doc.moveDown(0.5);
    } else {
      doc.moveDown(0.3);
    }

    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#ccc').stroke().strokeColor('#000');
    doc.moveDown(0.5);

    // Column layout: [num] [title .............. ] [dur]
    const NUM_W  = 28;
    const DUR_W  = 52;
    const SONG_X = L + NUM_W + 4;
    const DUR_X  = R - DUR_W;
    const SONG_W = DUR_X - SONG_X - 4;

    let total = 0;
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      total += song.length_min || 0;
      const dur  = formatLength(song.length_min);
      const meta = [song.key, song.genre].filter(Boolean).join(' · ');
      const y = doc.y;

      doc.font('Courier-Bold').fontSize(10)
         .text(`${i + 1}.`, L, y, { width: NUM_W, align: 'right', lineBreak: false });
      doc.font('Courier-Bold').fontSize(10)
         .text(song.title, SONG_X, y, { width: SONG_W, lineBreak: false });
      if (dur) {
        doc.font('Courier').fontSize(10)
           .text(dur, DUR_X, y, { width: DUR_W, align: 'right', lineBreak: false });
      }

      doc.y = y + 14; // fixed row height for 10pt font

      if (meta) {
        doc.font('Courier').fontSize(8).fillColor('#888')
           .text(meta, SONG_X, doc.y, { width: SONG_W });
        doc.fillColor('#000');
        doc.moveDown(0.2);
      } else {
        doc.moveDown(0.3);
      }
    }

    doc.moveDown(0.5);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#ccc').stroke().strokeColor('#000');
    doc.moveDown(0.3);

    doc.font('Courier').fontSize(9).fillColor('#666')
       .text(`${songs.length} song${songs.length !== 1 ? 's' : ''} · ${formatLength(total)}`,
             L, doc.y, { width: W, align: 'right' });

    doc.end();
  });
}

module.exports = { buildSetlistPdf, setlistTitle };
