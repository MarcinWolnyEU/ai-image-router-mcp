/**
 * The ONE magic-byte detector for every input the tools accept: images, video
 * containers and OCR documents. Everything else (`detectImageMime`, `sniffImageMime`,
 * media-kind resolution, the Mistral OCR/vision input checks) is built on it, so a
 * format is added in one place. It replaced five ad-hoc sniffers whose drifting
 * coverage sent AVIF to Mistral labelled `image/png` and classified every ISO-BMFF
 * `ftyp` file (AVIF/HEIC included) as video.
 *
 * Magic bytes are authoritative: callers must not let a declared mime (data: URL,
 * content-type header) override a detection, and `null` means "not a format we
 * accept", which fail-closed callers refuse.
 */

export type DetectedKind = 'image' | 'video' | 'document';

export interface DetectedMedia {
  kind: DetectedKind;
  mime: string;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** ISO-BMFF brands that make an `ftyp` file a still image rather than a movie. */
const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

/** BITMAPINFOHEADER-family sizes a real BMP declares at offset 14. */
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

const ascii = (b: Buffer, start: number, end: number): string => b.toString('latin1', start, end);

/** Major + compatible brands of a leading `ftyp` box (lowercased), or null when there is none. */
function ftypBrands(b: Buffer): string[] | null {
  if (b.length < 12 || ascii(b, 4, 8) !== 'ftyp') return null;
  const boxSize = b.readUInt32BE(0);
  const end = Math.min(b.length, boxSize >= 16 ? boxSize : 12);
  const brands = [ascii(b, 8, 12)];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(b, o, o + 4));
  return brands.map((s) => s.toLowerCase());
}

/**
 * An ICO directory: reserved 0, type 1, at least one entry whose reserved byte is 0
 * and whose plane count is 0 or 1. Four bytes alone (`00 00 01 00`) also start MPEG
 * start codes, so the first entry is checked too.
 */
export function isIcoSignature(b: Buffer): boolean {
  if (b.length < 22 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1 || b[3] !== 0) return false;
  const count = b.readUInt16LE(4);
  const planes = b.readUInt16LE(10);
  return count > 0 && b[9] === 0 && planes <= 1;
}

const startsWith = (b: Buffer, sig: readonly number[]): boolean => sig.every((v, i) => b[i] === v);

/** Formats identified purely by their leading bytes. */
const PREFIX_SIGNATURES: ReadonlyArray<{ sig: readonly number[]; media: DetectedMedia }> = [
  { sig: [0x89, 0x50, 0x4e, 0x47], media: { kind: 'image', mime: 'image/png' } },
  { sig: [0xff, 0xd8, 0xff], media: { kind: 'image', mime: 'image/jpeg' } },
  { sig: [0x47, 0x49, 0x46, 0x38], media: { kind: 'image', mime: 'image/gif' } }, // "GIF8"
  { sig: [0x49, 0x49, 0x2a, 0x00], media: { kind: 'image', mime: 'image/tiff' } }, // little-endian
  { sig: [0x4d, 0x4d, 0x00, 0x2a], media: { kind: 'image', mime: 'image/tiff' } }, // big-endian
];

type Detector = (b: Buffer, nameHint: string) => DetectedMedia | null;

const detectPrefixSignature: Detector = (b) => PREFIX_SIGNATURES.find((e) => startsWith(b, e.sig))?.media ?? null;

/** RIFF container: WebP still or AVI movie. */
const detectRiff: Detector = (b) => {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF') return null;
  const form = ascii(b, 8, 12);
  if (form === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (form === 'AVI ') return { kind: 'video', mime: 'video/x-msvideo' };
  return null;
};

/** "BM" plus a real DIB header size — a bare "BM" also starts plenty of text. */
const detectBmp: Detector = (b) =>
  b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d && b.readUInt32LE(6) === 0 && BMP_DIB_SIZES.has(b.readUInt32LE(14))
    ? { kind: 'image', mime: 'image/bmp' }
    : null;

const detectIco: Detector = (b) => (isIcoSignature(b) ? { kind: 'image', mime: 'image/x-icon' } : null);

/** ISO-BMFF: AVIF / HEIC stills vs mp4 / mov movies, told apart by their brands. */
const detectIsoBmff: Detector = (b) => {
  const brands = ftypBrands(b);
  if (!brands) return null;
  if (brands.some((x) => AVIF_BRANDS.has(x))) return { kind: 'image', mime: 'image/avif' };
  if (brands.some((x) => HEIF_BRANDS.has(x))) return { kind: 'image', mime: 'image/heic' };
  return { kind: 'video', mime: brands[0]!.startsWith('qt') ? 'video/quicktime' : 'video/mp4' };
};

/** EBML (webm / mkv): the DocType string sits in the first few dozen bytes. */
const detectEbml: Detector = (b) => {
  if (!startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return null;
  const head = ascii(b, 0, Math.min(b.length, 64));
  return { kind: 'video', mime: head.includes('matroska') ? 'video/x-matroska' : 'video/webm' };
};

/** OCR documents: PDF, and a zip container that `nameHint` resolves to PPTX (default DOCX). */
const detectDocument: Detector = (b, nameHint) => {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'document', mime: 'application/pdf' }; // "%PDF-"
  if (!startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(nameHint)?.[1]?.toLowerCase();
  return { kind: 'document', mime: ext === 'pptx' ? PPTX_MIME : DOCX_MIME };
};

/** Tried in order; each family claims only bytes it positively identifies. */
const DETECTORS: readonly Detector[] = [detectPrefixSignature, detectRiff, detectBmp, detectIco, detectIsoBmff, detectEbml, detectDocument];

/**
 * Identify bytes by signature. `nameHint` (a filename) only disambiguates a zip
 * container between DOCX and PPTX; it never makes unrecognised bytes acceptable.
 */
export function detectMedia(b: Buffer, nameHint = ''): DetectedMedia | null {
  if (b.length < 4) return null;
  for (const detect of DETECTORS) {
    const found = detect(b, nameHint);
    if (found) return found;
  }
  return null;
}

/** The image mime the bytes prove, or null for anything that is not a recognised image. */
export function detectImageMime(b: Buffer): string | null {
  const d = detectMedia(b);
  return d?.kind === 'image' ? d.mime : null;
}

/**
 * Image mime for bytes a provider returned without one: the detected type, else
 * `image/png` (the providers' de-facto default). Never use this to VALIDATE input —
 * it cannot say "not an image"; use `detectImageMime` for that.
 */
export function sniffImageMime(b: Buffer): string {
  return detectImageMime(b) ?? 'image/png';
}
