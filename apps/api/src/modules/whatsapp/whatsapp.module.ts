import { Module, forwardRef } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module';
import { OrderModule } from '../order/order.module';
import { ReviewModule } from '../review/review.module';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [MenuModule, ReviewModule, forwardRef(() => OrderModule)],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
