import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ProductModule } from './modules/product/product.module';
import { OrderModule } from './modules/order/order.module';
import { PaymentModule } from './modules/payment/payment.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { ReviewModule } from './modules/review/review.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { EventsModule } from './modules/events/events.module';
import { UploadModule } from './modules/upload/upload.module';
import { WhatsappStickerModule } from './modules/whatsapp-sticker/whatsapp-sticker.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    AdminModule,
    ProductModule,
    PaymentModule,
    OrderModule,
    ReviewModule,
    TenantModule,
    WhatsAppModule,
    DashboardModule,
    EventsModule,
    UploadModule,
    WhatsappStickerModule,
  ],
})
export class AppModule {}
