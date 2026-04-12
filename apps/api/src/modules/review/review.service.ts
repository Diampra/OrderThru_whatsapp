import { ReviewConversationState } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async createReviewsForOrder(tenantId: string, orderId: string, rating: number, comment: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        orderItems: true,
        reviews: true,
      },
    });

    if (!order || order.tenantId !== tenantId) {
      throw new NotFoundException('Order not found');
    }

    const existingProductIds = new Set(order.reviews.map((review: { productId: string }) => review.productId));

    const reviews = await this.prisma.$transaction(
      order.orderItems
        .filter((orderItem: { productId: string }) => !existingProductIds.has(orderItem.productId))
        .map((orderItem: { productId: string }) =>
          this.prisma.review.create({
            data: {
              rating,
              comment,
              productId: orderItem.productId,
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

  async getReviewSummaryByItemName(tenantId: string, itemName: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        tenantId: tenantId,
        name: {
          equals: itemName.trim(),
          mode: 'insensitive',
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const [aggregate, latestReviews] = await this.prisma.$transaction([
      this.prisma.review.aggregate({
        where: { productId: product.id },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.review.findMany({
        where: { productId: product.id },
        orderBy: { createdAt: 'desc' },
        take: 3,
      }),
    ]);

    return {
      product,
      averageRating: aggregate._avg.rating ?? 0,
      reviewCount: aggregate._count._all,
      latestReviews,
    };
  }

  listDashboardReviews(tenantId: string) {
    return this.prisma.review.findMany({
      where: { product: { tenantId: tenantId } },
      include: {
        product: true,
        order: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
