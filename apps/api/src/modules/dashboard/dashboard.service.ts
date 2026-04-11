import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const [ordersCount, pendingOrdersCount, completedOrdersCount, reviewAggregate, menuCount] =
      await this.prisma.$transaction([
        this.prisma.order.count(),
        this.prisma.order.count({ where: { status: 'PENDING' } }),
        this.prisma.order.count({ where: { status: 'COMPLETED' } }),
        this.prisma.review.aggregate({
          _avg: { rating: true },
          _count: { _all: true },
        }),
        this.prisma.menuItem.count(),
      ]);

    return {
      ordersCount,
      pendingOrdersCount,
      completedOrdersCount,
      reviewsCount: reviewAggregate._count._all,
      averageRating: reviewAggregate._avg.rating ?? 0,
      menuCount,
    };
  }
}
