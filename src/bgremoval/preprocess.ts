import sharp from 'sharp';

/** Decoded source pixels for background removal: tightly packed RGB, top-down. */
export interface OrientedRgb {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Decode an input image ONCE, as it is DISPLAYED: EXIF orientation applied (`.rotate()`),
 * alpha dropped, exactly 3 channels. Both the model input and the final RGBA composite are
 * built from these pixels — reading metadata/raw pixels without the rotation (the output PNG
 * carries no EXIF) turned a portrait phone photo into a sideways landscape cutout.
 */
export async function decodeOrientedRgb(input: Buffer): Promise<OrientedRgb> {
  const { data, info } = await sharp(input).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels after decode, got ${info.channels}`);
  return { data, width: info.width, height: info.height };
}
