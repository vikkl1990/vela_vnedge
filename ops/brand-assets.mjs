/** Rebuild the SVG brand kit. Optional PNG exports: SHARP_MODULE=/path/to/sharp node ops/brand-assets.mjs --png */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dest = fileURLToPath(new URL('../dashboard/public/brand/', import.meta.url));
await fs.mkdir(dest, { recursive: true });
// Four solid pieces traced from the supplied monochrome reference (docs/brand/source/black.jpg).
const mark = '<path d="M0 31H35L87 105L68 128Z M50 31H84L113 71L96 96Z M70 144H103L180 39L192 54L199 0L137 31H158Z M133 120H159L187 64L178 56Z"/>';
// Outlined lettering keeps the logo independent of installed fonts.
const wordmark = '<path fill-rule="evenodd" d="M0 1H12L25 30L39 1H51L31 42H20Z M57 1H68L86 26V1H97V42H86L68 17V42H57Z M121 1H157V9H132V17H155V25H132V34H159V42H121Z M170 1H190C208 1 216 8 216 21.5C216 35 208 42 190 42H170Z M181 10V33H190C200 33 205 30 205 21.5C205 13 200 10 190 10Z M282 4L279 13C273 10 267 9 260 9C249 9 242 13 242 22C242 31 249 35 260 35C265 35 269 34 273 33V26H258V18H284V39C276 42 269 43 259 43C241 43 231 35 231 22C231 8 241 0 259 0C269 0 276 1 282 4Z M296 1H331V9H307V17H329V25H307V34H332V42H296Z"/>';
const gradient = '<defs><linearGradient id="edge-blue" x1="0" y1="0" x2="0.65" y2="1"><stop stop-color="#2ca9f4"/><stop offset="1" stop-color="#1878f2"/></linearGradient></defs>';
const svg = (viewBox, content) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="VN EDGE"><title>VN EDGE</title>${content}</svg>\n`;
const variants = { blue: 'url(#edge-blue)', white: '#ffffff', black: '#252525' };
for (const [name, fill] of Object.entries(variants)) {
  const defs = name === 'blue' ? gradient : '';
  await fs.writeFile(path.join(dest, `mark${name === 'blue' ? '' : `-${name}`}.svg`), svg('0 0 200 146', `${defs}<g fill="${fill}">${mark}</g>`));
  await fs.writeFile(path.join(dest, `logo-${name}.svg`), svg('0 0 332 226', `${defs}<g fill="${fill}"><g transform="translate(66 0)">${mark}</g><g transform="translate(0 183)" fill="${name === 'blue' ? '#1878f2' : fill}">${wordmark}</g></g>`));
}
const icon = (size, maskable = false) => {
  const width = size * (maskable ? .56 : .76), scale = width / 200;
  const x = (size - width) / 2, y = (size - 146 * scale) / 2;
  return svg(`0 0 ${size} ${size}`, `<rect width="${size}" height="${size}" rx="${maskable ? 0 : size * .18}" fill="#0e1422"/><g transform="translate(${x} ${y}) scale(${scale})" fill="#ffffff">${mark}</g>`);
};
await fs.writeFile(path.join(dest, '..', 'favicon.svg'), icon(64));
if (process.argv.includes('--png')) {
  const { default: sharp } = await import(process.env.SHARP_MODULE ? pathToFileURL(process.env.SHARP_MODULE).href : 'sharp');
  for (const size of [32, 192, 512]) await sharp(Buffer.from(icon(size))).resize(size, size).png().toFile(path.join(dest, `icon-${size}.png`));
  // Touch icons use an opaque square; the operating system supplies its own corner mask.
  await sharp(Buffer.from(icon(180, true))).resize(180, 180).png().toFile(path.join(dest, 'apple-touch-icon.png'));
  await sharp(Buffer.from(icon(512, true))).resize(512, 512).png().toFile(path.join(dest, 'icon-maskable-512.png'));
  for (const name of Object.keys(variants)) {
    await sharp(path.join(dest, `logo-${name}.svg`), { density: 144 }).resize(996, 678).png().toFile(path.join(dest, `logo-${name}.png`));
  }
}
console.log('VN EDGE brand assets generated.');
