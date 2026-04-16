import { BadRequestException } from '@nestjs/common';
import { StickerConverterService } from '../src/modules/whatsapp-sticker/sticker-converter.service';
import sharp from 'sharp';

describe('StickerConverterService', () => {
  let service: StickerConverterService;

  beforeEach(() => {
    service = new StickerConverterService();
  });

  /**
   * Helper: create a test PNG buffer with specified dimensions.
   */
  async function createTestPng(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
  }

  it('should convert a PNG to WEBP at 512x512', async () => {
    const png = await createTestPng(1000, 800);
    const webp = await service.convertToWebp(png);

    // Verify output format and dimensions
    const metadata = await sharp(webp).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
  });

  it('should produce output under 100KB', async () => {
    const png = await createTestPng(1000, 800);
    const webp = await service.convertToWebp(png);

    expect(webp.length).toBeLessThanOrEqual(100 * 1024);
  });

  it('should handle small images (upscaling to 512x512)', async () => {
    const png = await createTestPng(100, 100);
    const webp = await service.convertToWebp(png);

    const metadata = await sharp(webp).metadata();
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
  });

  it('should handle square images', async () => {
    const png = await createTestPng(512, 512);
    const webp = await service.convertToWebp(png);

    const metadata = await sharp(webp).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    expect(webp.length).toBeLessThanOrEqual(100 * 1024);
  });

  it('should preserve transparency', async () => {
    const png = await createTestPng(256, 256);
    const webp = await service.convertToWebp(png);

    const metadata = await sharp(webp).metadata();
    expect(metadata.hasAlpha).toBe(true);
  });
});
