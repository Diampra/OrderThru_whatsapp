import { Module, forwardRef } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module';
import { PaymentModule } from '../payment/payment.module';
import { ReviewModule } from '../review/review.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  imports: [MenuModule, PaymentModule, ReviewModule, forwardRef(() => WhatsAppModule)],
  controllers: [OrderController],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrderModule {}
