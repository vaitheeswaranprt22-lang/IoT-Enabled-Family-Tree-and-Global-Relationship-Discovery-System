/**
 * Client-side image and PDF export for the family tree.
 *
 * The server renders the tree as SVG; this module rasterises it in a canvas
 * and, for PDF, wraps the resulting JPEG in a minimal single-page document.
 * Writing the ~60 lines of PDF here avoids shipping a PDF library for one
 * feature, and keeps the whole project dependency-free.
 */

/** Loads an SVG string into an Image via a blob URL. */
function svgToImage(svgText) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The tree image could not be rendered.')); };
    image.src = url;
  });
}

/**
 * SVG uses CSS custom properties for colour, which do not survive being
 * detached from the document. This resolves the tokens the renderer uses into
 * literal values and forces a light background, so an exported file looks the
 * same for everyone regardless of the theme they were viewing in.
 */
function inlineThemeTokens(svgText) {
  const computed = getComputedStyle(document.documentElement);
  const LIGHT = {
    '--text': '#14272b', '--text-muted': '#5b7076', '--text-faint': '#8ba0a6',
    '--surface': '#ffffff', '--surface-2': '#f1f5f6', '--surface-3': '#e6edee',
    '--border': '#dde5e7', '--border-strong': '#c3d0d3',
    '--accent': '#0d8578', '--teal-500': '#16a394', '--violet-500': '#8b5cf6',
    '--violet-700': '#6d28d9', '--blue-100': '#dbeafe', '--blue-500': '#3b82f6',
    '--rose-100': '#ffe4e6', '--rose-500': '#e11d48',
  };
  return svgText.replace(/var\((--[a-z0-9-]+)\)/gi, (match, token) =>
    LIGHT[token] ?? (computed.getPropertyValue(token).trim() || '#333333'));
}

/** Rasterises the SVG onto a white canvas at `scale` device pixels per unit. */
export async function svgToCanvas(svgText, scale = 2) {
  const prepared = inlineThemeTokens(svgText);
  const image = await svgToImage(prepared);

  const width = image.naturalWidth || image.width || 1200;
  const height = image.naturalHeight || image.height || 800;

  const canvas = document.createElement('canvas');
  canvas.width = Math.min(8000, Math.ceil(width * scale));
  canvas.height = Math.min(8000, Math.ceil(height * scale));

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvas;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type }), filename);
}

export async function exportPng(svgText, filename = 'family-tree.png') {
  const canvas = await svgToCanvas(svgText, 2);
  await new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, filename);
      resolve();
    }, 'image/png');
  });
}

// ------------------------------------------------------------------- PDF ---

/** Escapes a string for a PDF literal. */
const pdfString = (value) =>
  `(${String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;

/**
 * Builds a one-page PDF containing the tree image, scaled to fit A4 landscape
 * with a small margin and a caption.
 */
export async function exportPdf(svgText, { filename = 'family-tree.pdf', title = 'Family tree', subtitle = '' } = {}) {
  const canvas = await svgToCanvas(svgText, 2);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const imageBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) imageBytes[i] = binary.charCodeAt(i);

  // A4 landscape in PostScript points.
  const PAGE_W = 841.89;
  const PAGE_H = 595.28;
  const MARGIN = 28;
  const HEADER = 46;

  const availableW = PAGE_W - MARGIN * 2;
  const availableH = PAGE_H - MARGIN * 2 - HEADER;
  const scale = Math.min(availableW / canvas.width, availableH / canvas.height);
  const drawW = canvas.width * scale;
  const drawH = canvas.height * scale;
  const drawX = MARGIN + (availableW - drawW) / 2;
  const drawY = MARGIN + (availableH - drawH) / 2;

  const contentStream =
    `BT /F1 15 Tf ${MARGIN} ${PAGE_H - MARGIN - 12} Td ${pdfString(title)} Tj ET\n` +
    `BT /F2 9 Tf ${MARGIN} ${PAGE_H - MARGIN - 28} Td ${pdfString(subtitle)} Tj ET\n` +
    `q ${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm /Im0 Do Q\n`;

  // Assemble the file, recording each object's byte offset for the xref table.
  const chunks = [];
  const offsets = [0];
  let length = 0;

  const encoder = new TextEncoder();
  const pushText = (text) => { const bytes = encoder.encode(text); chunks.push(bytes); length += bytes.length; };
  const pushBytes = (bytes) => { chunks.push(bytes); length += bytes.length; };
  const startObject = () => { offsets.push(length); };

  pushText('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  startObject();
  pushText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  startObject();
  pushText('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  startObject();
  pushText(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
    `/Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R /F2 7 0 R >> >> ` +
    `/Contents 4 0 R >>\nendobj\n`
  );

  startObject();
  pushText(`4 0 obj\n<< /Length ${encoder.encode(contentStream).length} >>\nstream\n`);
  pushText(contentStream);
  pushText('endstream\nendobj\n');

  startObject();
  pushText(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`
  );
  pushBytes(imageBytes);
  pushText('\nendstream\nendobj\n');

  startObject();
  pushText('6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');

  startObject();
  pushText('7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  const xrefOffset = length;
  const objectCount = offsets.length;   // object 0 is the free head
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let i = 1; i < objectCount; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pushText(xref);
  pushText(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  downloadBlob(new Blob(chunks, { type: 'application/pdf' }), filename);
}
