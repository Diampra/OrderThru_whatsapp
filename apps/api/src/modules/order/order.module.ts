import { Module, forwardRef } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { PaymentModule } from '../payment/payment.module';
import { ReviewModule } from '../review/review.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { EventsModule } from '../events/events.module';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { AbandonedCartService } from './abandoned-cart.service';

@Module({
  imports: [ProductModule, PaymentModule, ReviewModule, forwardRef(() => WhatsAppModule), EventsModule],
  controllers: [OrderController],
  providers: [OrderService, AbandonedCartService],
  exports: [OrderService],
})
export class OrderModule {}
