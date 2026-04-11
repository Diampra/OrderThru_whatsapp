import { ReviewConversationState } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async createReviewsForOrder(orderId: string, rating: number, comment: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        orderItems: true,
        reviews: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const existingItemIds = new Set(order.reviews.map((review: { itemId: string }) => review.itemId));

    const reviews = await this.prisma.$transaction(
      order.orderItems
        .filter((orderItem: { itemId: string }) => !existingItemIds.has(orderItem.itemId))
        .map((orderItem: { itemId: string }) =>
          this.prisma.review.create({
            data: {
              rating,
              comment,
              itemId: orderItem.itemId,
              orderId,
            },
          }),
        ),
    );

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        reviewConversation: ReviewConversationState.NONE,
        pendingReviewRating: null,
      },
    });

    return reviews;
  }

  async getReviewSummaryByItemName(itemName: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: {
        name: {
          equals: itemName.trim(),
          mode: 'insensitive',
        },
      },
    });

    if (!item) {
      throw new NotFoundException('Menu item not found');
    }

    const [aggregate, latestReviews] = await this.prisma.$transaction([
      this.prisma.review.aggregate({
        where: { itemId: item.id },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.review.findMany({
        where: { itemId: item.id },
        orderBy: { createdAt: 'desc' },
        take: 3,
      }),
    ]);

    return {
      item,
      averageRating: aggregate._avg.rating ?? 0,
      reviewCount: aggregate._count._all,
      latestReviews,
    };
  }

  listDashboardReviews() {
    return this.prisma.review.findMany({
      include: {
        item: true,
        order: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
