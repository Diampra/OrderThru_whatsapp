import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { WhatsappStickerController } from './whatsapp-sticker.controller';
import { WhatsappStickerService } from './whatsapp-sticker.service';
import { StickerConverterService } from './sticker-converter.service';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
  ],
  controllers: [WhatsappStickerController],
  providers: [WhatsappStickerService, StickerConverterService],
  exports: [WhatsappStickerService],
})
export class WhatsappStickerModule {}
