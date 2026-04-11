import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './modules/auth/auth.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MenuModule } from './modules/menu/menu.module';
import { OrderModule } from './modules/order/order.module';
import { PaymentModule } from './modules/payment/payment.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { ReviewModule } from './modules/review/review.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    MenuModule,
    PaymentModule,
    OrderModule,
    ReviewModule,
    WhatsAppModule,
    DashboardModule,
  ],
})
export class AppModule {}
