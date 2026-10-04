import sharp from 'sharp';

export interface EditedImage {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Crop an exact pixel region (sharp .extract). Preserves the input format. A region that
 * leaves the image is refused with the actual bounds (libvips only says "bad extract area").
 */
export async function cropImage(
  input: Buffer | string,
  region: { left: number; top: number; width: number; height: number },
): Promise<EditedImage> {
  const { width = 0, height = 0 } = await sharp(input).metadata();
  if (region.left + region.width > width || region.top + region.height > height) {
    throw new Error(
      `Crop region (left ${region.left}, top ${region.top}, ${region.width}×${region.height}) exceeds the image bounds (${width}×${height}): ` +
        `left + width must be ≤ ${width} and top + height ≤ ${height}.`,
    );
  }
  const out = await sharp(input)
    .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
    .toBuffer({ resolveWithObject: true });
  return { bytes: out.data, mimeType: `image/${out.info.format}` };
}

/**
 * Downsize using the Magic Kernel Sharp 2021 kernel, only ever shrinking
 * (withoutEnlargement). Fits INSIDE width×height, preserving aspect ratio — sharp's
 * default fit is `cover`, which center-CROPPED to the box when both were given.
 * Preserves the input format.
 */
export async function downsizeImage(input: Buffer | string, dims: { width?: number; height?: number }): Promise<EditedImage> {
  const out = await sharp(input)
    .resize({
      ...(dims.width != null ? { width: dims.width } : {}),
      ...(dims.height != null ? { height: dims.height } : {}),
      fit: 'inside',
      kernel: 'mks2021',
      withoutEnlargement: true,
    })
    .toBuffer({ resolveWithObject: true });
  return { bytes: out.data, mimeType: `image/${out.info.format}` };
}

/**
 * Fraction of pixels in a raw interleaved buffer that are "black" — i.e. whose
 * brightest channel is below `threshold`. Pure (no I/O) so it's unit-testable.
 */
export function blackFraction(raw: Buffer, channels: number, threshold = 32): number {
  if (channels < 1) return 1;
  const px = Math.floor(raw.length / channels);
  if (px === 0) return 1;
  let black = 0;
  for (let i = 0; i < px; i++) {
    const o = i * channels;
    const r = raw[o] ?? 0;
    const g = channels > 1 ? (raw[o + 1] ?? 0) : r;
    const b = channels > 2 ? (raw[o + 2] ?? 0) : r;
    if (Math.max(r, g, b) < threshold) black++;
  }
  return black / px;
}

/** Fraction of (alpha-stripped) pixels of a PNG/image that are near-black. */
export async function frameBlackFraction(imageBytes: Buffer, threshold = 32): Promise<number> {
  const { data, info } = await sharp(imageBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return blackFraction(data, info.channels, threshold);
}
