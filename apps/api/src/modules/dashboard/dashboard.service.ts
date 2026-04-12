import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { OrderService } from '../order/order.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsappService: WhatsAppService,
    private readonly orderService: OrderService,
  ) {}

  async getSummary(tenantId: string) {
    const [ordersCount, pendingOrdersCount, completedOrdersCount, reviewAggregate, productCount] =
      await this.prisma.$transaction([
        this.prisma.order.count({ where: { tenantId, status: { not: 'DRAFT' } } }),
        this.prisma.order.count({ where: { tenantId, status: 'PENDING' } }),
        this.prisma.order.count({ where: { tenantId, status: 'COMPLETED' } }),
        this.prisma.review.aggregate({
          where: { product: { tenantId } },
          _avg: { rating: true },
          _count: { _all: true },
        }),
        this.prisma.product.count({ where: { tenantId } }),
      ]);

    return {
      ordersCount,
      pendingOrdersCount,
      completedOrdersCount,
      reviewsCount: reviewAggregate._count._all,
      averageRating: reviewAggregate._avg.rating ?? 0,
      productCount,
    };
  }

  async getAlerts(tenantId: string) {
    return this.prisma.staffAlert.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async dismissAlert(tenantId: string, alertId: string) {
    return this.prisma.staffAlert.updateMany({
      where: { id: alertId, tenantId },
      data: { isDismissed: true },
    });
  }

  async sendReply(tenantId: string, customerPhone: string, message: string) {
    return this.whatsappService.sendTextMessage(tenantId, customerPhone, message, 'STAFF');
  }

  async createManualOrder(tenantId: string, customerPhone: string, items: Array<{ productId: string; quantity: number }>) {
    return this.orderService.createManualOrder(tenantId, customerPhone, items);
  }
}
