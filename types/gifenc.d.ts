declare module "gifenc" {
  export type GifPalette = unknown;

  export function quantize(pixels: ArrayLike<number>, maxColors: number): GifPalette;

  export function applyPalette(pixels: ArrayLike<number>, palette: GifPalette): Uint8Array;

  export type GIFEncoderInstance = {
    writeFrame(
      index: ArrayLike<number>,
      width: number,
      height: number,
      options?: {
        palette?: GifPalette;
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };

  export function GIFEncoder(): GIFEncoderInstance;
}
