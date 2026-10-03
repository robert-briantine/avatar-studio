import sharp from "sharp";

function escapeXml(s: string): string {
  return s.replace(/[<>&\"']/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;"
  })[c] ?? c);
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  lines.push(line);
  return lines;
}

export async function addExactText(
  image: Buffer,
  text: string,
  opts: { position: "top" | "center" | "bottom"; fontSize: number }
): Promise<Buffer> {
  const source = sharp(image);
  const meta = await source.metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const fontSize = Math.max(24, Math.min(opts.fontSize, Math.round(width / 6)));
  const maxChars = Math.max(8, Math.floor((width * 0.82) / (fontSize * 0.58)));
  const lines = wrapText(text, maxChars);
  if (!lines.length) return image;

  const lineHeight = Math.round(fontSize * 1.18);
  const blockHeight = lines.length * lineHeight + Math.round(fontSize * 0.65);
  let y0 = Math.round(height * 0.08);
  if (opts.position === "center") y0 = Math.round((height - blockHeight) / 2);
  if (opts.position === "bottom") y0 = Math.round(height - blockHeight - height * 0.08);
  y0 = Math.max(0, Math.min(y0, height - blockHeight));

  const tspans = lines.map((line, i) =>
    `<tspan x="50%" y="${y0 + Math.round(fontSize * 0.9) + i * lineHeight}">${escapeXml(line)}</tspan>`
  ).join("");

  const svg = Buffer.from(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="5%" y="${y0}" width="90%" height="${blockHeight}" rx="${Math.round(fontSize * 0.25)}"
          fill="black" fill-opacity="0.48"/>
    <text text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="700"
          font-size="${fontSize}" fill="white" stroke="black" stroke-width="${Math.max(2, Math.round(fontSize / 22))}"
          paint-order="stroke fill">${tspans}</text>
  </svg>`);

  return source.composite([{ input: svg }]).png().toBuffer();
}
