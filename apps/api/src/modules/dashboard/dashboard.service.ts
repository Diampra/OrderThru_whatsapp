import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

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
}
