import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { OrderModule } from '../order/order.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [WhatsAppModule, OrderModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
