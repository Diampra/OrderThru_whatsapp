import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

const MAX_SIZE_BYTES = 100 * 1024; // 100 KB
const TARGET_DIMENSION = 512;

@Injectable()
export class StickerConverterService {
  private readonly logger = new Logger(StickerConverterService.name);

  /**
   * Convert a PNG buffer to a WhatsApp-compliant WEBP sticker.
   *
   * Spec: 512×512, transparent background, webp, <100KB.
   * Quality reduction loop: 80 → 70 → 60 → 60 (no metadata) → fail.
   */
  async convertToWebp(pngBuffer: Buffer): Promise<Buffer> {
    const qualitySteps = [80, 70, 60];

    for (const quality of qualitySteps) {
      const webpBuffer = await sharp(pngBuffer)
        .resize(TARGET_DIMENSION, TARGET_DIMENSION, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .webp({ quality })
        .toBuffer();

      this.logger.debug(`WEBP conversion at quality=${quality}: ${webpBuffer.length} bytes`);

      if (webpBuffer.length <= MAX_SIZE_BYTES) {
        return webpBuffer;
      }
    }

    // Final attempt: quality 60 + strip metadata
    const finalBuffer = await sharp(pngBuffer)
      .resize(TARGET_DIMENSION, TARGET_DIMENSION, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .withMetadata(false as any)
      .webp({ quality: 60 })
      .toBuffer();

    this.logger.debug(`WEBP conversion at quality=60 (no metadata): ${finalBuffer.length} bytes`);

    if (finalBuffer.length <= MAX_SIZE_BYTES) {
      return finalBuffer;
    }

    throw new BadRequestException(
      `Sticker too large after compression: ${finalBuffer.length} bytes (max ${MAX_SIZE_BYTES} bytes). ` +
        'Try using a simpler image with fewer colors.',
    );
  }
}
