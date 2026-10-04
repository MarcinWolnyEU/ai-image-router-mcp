/** ICO decoding helper shared by the icon tests (`ico.test.ts`, `iconSet.test.ts`). */
import { parseIco, icoEntryToRgba } from '../../src/media/ico.js';

export interface IcoLayer {
  width: number;
  height: number;
  data: Buffer;
}

/** Decode an ICO back into its layers (sizes) + raw top-down RGBA pixel data. */
export async function icoLayers(bytes: Buffer): Promise<IcoLayer[]> {
  return (await parseIco(bytes)).map((img) => icoEntryToRgba(img));
}
