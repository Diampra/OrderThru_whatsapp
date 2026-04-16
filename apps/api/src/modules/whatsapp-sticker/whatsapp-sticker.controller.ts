import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { Role } from '@prisma/client';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { WhatsappStickerService } from './whatsapp-sticker.service';
import { UploadStickerDto } from './dto/upload-sticker.dto';
import { SendStickerDto } from './dto/send-sticker.dto';

@Controller('whatsapp/stickers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WhatsappStickerController {
  constructor(private readonly stickerService: WhatsappStickerService) {}

  // ─── Super Admin: Upload sticker to global catalog ──────────
  @Post('upload')
  @Roles(Role.SUPER_ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const uploadPath = join(process.cwd(), 'uploads', 'stickers');
          if (!existsSync(uploadPath)) {
            mkdirSync(uploadPath, { recursive: true });
          }
          cb(null, uploadPath);
        },
        filename: (_req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, `${uniqueSuffix}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        if (file.mimetype !== 'image/png') {
          return cb(new BadRequestException('Only PNG files are accepted for stickers'), false);
        }
        cb(null, true);
      },
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit for source PNGs
      },
    }),
  )
  async uploadSticker(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadStickerDto,
  ) {
    return this.stickerService.uploadSticker(file, dto);
  }

  // ─── Both roles: Browse sticker catalog ─────────────────────
  @Get()
  @Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN)
  async listStickers() {
    return this.stickerService.listStickers();
  }

  // ─── Super Admin: Delete a sticker ──────────────────────────
  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  async deleteSticker(@Param('id') id: string) {
    return this.stickerService.deleteSticker(id);
  }

  // ─── Tenant Admin: Send sticker to user's WhatsApp ──────────
  @Post('send')
  @Roles(Role.TENANT_ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async sendSticker(@Body() dto: SendStickerDto, @Req() req: any) {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found in user session');
    }
    return this.stickerService.sendSticker(dto, tenantId);
  }
}
