import { Module, forwardRef } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { OrderModule } from '../order/order.module';
import { ReviewModule } from '../review/review.module';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppSessionService } from './whatsapp-session.service';
import { EventsModule } from '../events/events.module';

import { WhatsappStickerModule } from '../whatsapp-sticker/whatsapp-sticker.module';

@Module({
  imports: [ProductModule, ReviewModule, EventsModule, forwardRef(() => OrderModule), WhatsappStickerModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, WhatsAppSessionService],
  exports: [WhatsAppService, WhatsAppSessionService],
})
export class WhatsAppModule {}
