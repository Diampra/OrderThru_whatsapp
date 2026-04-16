import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import axios from 'axios';
import FormData from 'form-data';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { StickerConverterService } from './sticker-converter.service';
import { SendStickerDto } from './dto/send-sticker.dto';
import { UploadStickerDto } from './dto/upload-sticker.dto';

@Injectable()
export class WhatsappStickerService {
  private readonly logger = new Logger(WhatsappStickerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly converter: StickerConverterService,
  ) {}

  // ──────────────────────────────────────────────
  // Super Admin: Upload sticker to global catalog
  // ──────────────────────────────────────────────

  async uploadSticker(file: Express.Multer.File, dto: UploadStickerDto) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (!file.mimetype.includes('png')) {
      throw new BadRequestException('Only PNG files are accepted for stickers');
    }

    const sticker = await this.prisma.sticker.create({
      data: {
        name: dto.name,
        category: dto.category || 'General',
        tags: dto.tags ?? [],
        fileUrl: `/uploads/stickers/${file.filename}`,
      },
    });

    this.logger.log(`Sticker uploaded: ${sticker.id} (${sticker.name})`);
    return sticker;
  }

  // ──────────────────────────────────────────────
  // Both roles: List all stickers
  // ──────────────────────────────────────────────

  async listStickers() {
    return this.prisma.sticker.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  // ──────────────────────────────────────────────
  // Super Admin: Delete a sticker
  // ──────────────────────────────────────────────

  async deleteSticker(id: string) {
    const sticker = await this.prisma.sticker.findUnique({ where: { id } });
    if (!sticker) {
      throw new NotFoundException('Sticker not found');
    }

    // Delete file from disk
    const filePath = join(process.cwd(), sticker.fileUrl);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch (err: any) {
        this.logger.warn(`Could not delete sticker file: ${err.message}`);
      }
    }

    // Invalidate cached media_ids across ALL tenants
    await this.prisma.stickerMediaCache.deleteMany({
      where: { stickerId: id },
    });

    await this.prisma.sticker.delete({ where: { id } });
    this.logger.log(`Sticker deleted: ${id}`);

    return { success: true };
  }

  // ──────────────────────────────────────────────
  // Tenant Admin: Send sticker to a WhatsApp user
  // ──────────────────────────────────────────────

  async sendSticker(dto: SendStickerDto, tenantId: string) {
    // Step 1: Load tenant credentials (NEVER use env vars directly)
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    if (!tenant.whatsappAccessToken || !tenant.whatsappPhoneNumberId) {
      throw new BadRequestException('WhatsApp not configured for this tenant');
    }

    const accessToken = tenant.whatsappAccessToken;
    const phoneNumberId = tenant.whatsappPhoneNumberId;
    const apiVersion = tenant.whatsappApiVersion || 'v20.0';

    // Step 2: Validate sticker exists in our catalog
    const sticker = await this.prisma.sticker.findUnique({ where: { id: dto.stickerId } });
    if (!sticker) {
      throw new NotFoundException('Sticker not found in catalog');
    }

    // Step 3: Check per-tenant media_id cache
    const cached = await this.prisma.stickerMediaCache.findUnique({
      where: {
        stickerId_tenantId: {
          stickerId: dto.stickerId,
          tenantId,
        },
      },
    });

    let mediaId: string;

    if (cached && cached.expiresAt > new Date()) {
      // Cache hit — reuse media_id (scoped to this tenant's WABA)
      this.logger.debug(`Cache hit for sticker ${dto.stickerId} on tenant ${tenantId}: mediaId=${cached.mediaId}`);
      mediaId = cached.mediaId;
    } else {
      // Cache miss — convert + upload to this tenant's WABA
      mediaId = await this.convertAndUpload(sticker, tenantId, accessToken, phoneNumberId, apiVersion);
    }

    // Step 4: Send the sticker message
    const messageId = await this.sendStickerMessage(
      dto.phoneNumber,
      mediaId,
      accessToken,
      phoneNumberId,
      apiVersion,
    );

    return { success: true, messageId };
  }

  // ──────────────────────────────────────────────
  // Private: Convert PNG → WEBP + Upload to WABA
  // ──────────────────────────────────────────────

  private async convertAndUpload(
    sticker: { id: string; fileUrl: string },
    tenantId: string,
    accessToken: string,
    phoneNumberId: string,
    apiVersion: string,
  ): Promise<string> {
    // Load original PNG from disk
    const filePath = join(process.cwd(), sticker.fileUrl);
    if (!existsSync(filePath)) {
      throw new NotFoundException(`Sticker file not found on disk: ${sticker.fileUrl}`);
    }

    const pngBuffer = readFileSync(filePath);
    this.logger.log(`Converting sticker ${sticker.id}: ${pngBuffer.length} bytes`);

    // Convert to WEBP
    const webpBuffer = await this.converter.convertToWebp(pngBuffer);
    this.logger.log(`Sticker ${sticker.id} converted: ${webpBuffer.length} bytes`);

    // Upload to WhatsApp Media API
    const mediaId = await this.uploadToWhatsApp(webpBuffer, accessToken, phoneNumberId, apiVersion);

    // Cache the media_id with 30-day expiry (scoped to this tenant)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await this.prisma.stickerMediaCache.upsert({
      where: {
        stickerId_tenantId: {
          stickerId: sticker.id,
          tenantId,
        },
      },
      create: {
        stickerId: sticker.id,
        tenantId,
        mediaId,
        expiresAt,
      },
      update: {
        mediaId,
        expiresAt,
      },
    });

    this.logger.log(`Cached media_id ${mediaId} for sticker ${sticker.id} on tenant ${tenantId}`);
    return mediaId;
  }

  // ──────────────────────────────────────────────
  // Private: Upload WEBP buffer to WhatsApp Media API
  // ──────────────────────────────────────────────

  private async uploadToWhatsApp(
    webpBuffer: Buffer,
    accessToken: string,
    phoneNumberId: string,
    apiVersion: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('file', webpBuffer, {
      filename: 'sticker.webp',
      contentType: 'image/webp',
    });
    form.append('type', 'image/webp');
    form.append('messaging_product', 'whatsapp');

    try {
      this.logger.log(`Uploading sticker to WhatsApp Media API (${phoneNumberId})...`);
      const response = await axios.post(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`,
        form,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...form.getHeaders(),
          },
        },
      );

      const mediaId = response.data.id;
      this.logger.log(`WhatsApp Media upload successful: media_id=${mediaId}`);
      return mediaId;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'Media upload');
      throw error; // unreachable — handleWhatsAppError always throws
    }
  }

  // ──────────────────────────────────────────────
  // Private: Send sticker message via Messages API
  // ──────────────────────────────────────────────

  private async sendStickerMessage(
    phoneNumber: string,
    mediaId: string,
    accessToken: string,
    phoneNumberId: string,
    apiVersion: string,
  ): Promise<string> {
    try {
      this.logger.log(`Sending sticker to ${phoneNumber} via ${phoneNumberId}...`);
      const response = await axios.post(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'sticker',
          sticker: { id: mediaId },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const messageId = response.data.messages?.[0]?.id;
      this.logger.log(`Sticker sent successfully to ${phoneNumber}: messageId=${messageId}`);
      return messageId;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'Send sticker');
      throw error; // unreachable
    }
  }

  // ──────────────────────────────────────────────
  // Private: Centralized WhatsApp error handling
  // ──────────────────────────────────────────────

  private handleWhatsAppError(error: any, context: string): never {
    const status = error.response?.status;
    const data = error.response?.data;
    const errorCode = data?.error?.code;
    const errorMessage = data?.error?.message || '';

    this.logger.error(
      `${context} failed: status=${status}, code=${errorCode}, message=${errorMessage}`,
      JSON.stringify(data),
    );

    if (status === 401) {
      throw new UnauthorizedException('WhatsApp token expired');
    }

    if (status === 400 && errorMessage.includes('Invalid parameter')) {
      throw new BadRequestException('Sticker format rejected by WhatsApp');
    }

    if (errorCode === 131047) {
      throw new BadRequestException(
        'User must start chat with us first or we need template message',
      );
    }

    throw new HttpException(
      `WhatsApp API error: ${errorMessage || error.message}`,
      HttpStatus.BAD_GATEWAY,
    );
  }
}
