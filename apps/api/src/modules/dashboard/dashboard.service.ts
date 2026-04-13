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

  /**
   * Returns one entry per unique customer phone with their latest message
   * and count of unresolved alerts — powering the left-panel conversation list.
   */
  async getConversations(tenantId: string) {
    // Get the latest ChatMessage per customer phone
    const latestMessages = await this.prisma.chatMessage.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      distinct: ['customerPhone'],
      select: {
        customerPhone: true,
        content: true,
        sender: true,
        createdAt: true,
      },
    });

    if (!latestMessages.length) return [];

    // Get unresolved alert counts per customer
    const alertCounts = await this.prisma.staffAlert.groupBy({
      by: ['customerPhone'],
      where: { tenantId, isDismissed: false },
      _count: { _all: true },
    });

    const alertCountMap = new Map(
      alertCounts.map((a) => [a.customerPhone, a._count._all]),
    );

    return latestMessages.map((msg) => ({
      customerPhone: msg.customerPhone,
      lastMessage: msg.content,
      lastMessageAt: msg.createdAt,
      lastMessageSender: msg.sender,
      unresolvedAlertCount: alertCountMap.get(msg.customerPhone) ?? 0,
    }));
  }

  /**
   * Returns the full chronological message history for a specific customer,
   * merging ChatMessages and StaffAlert triggers as SYSTEM events.
   */
  async getChatHistory(tenantId: string, customerPhone: string) {
    const [messages, alerts] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { tenantId, customerPhone },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      this.prisma.staffAlert.findMany({
        where: { tenantId, customerPhone },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    ]);

    // Map alerts to a "SYSTEM" message format
    const alertMessages = alerts.map((a) => ({
      id: `alert-${a.id}`,
      customerPhone: a.customerPhone,
      sender: 'SYSTEM',
      content: `⚠️ ALERT: ${a.reason}`,
      createdAt: a.createdAt,
    }));

    // Merge and sort
    const combined = [...messages, ...alertMessages].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    return combined;
  }

  /**
   * Resolves all active alerts for a customer (marks all as dismissed).
   */
  async resolveConversation(tenantId: string, customerPhone: string) {
    return this.prisma.staffAlert.updateMany({
      where: { tenantId, customerPhone, isDismissed: false },
      data: { isDismissed: true },
    });
  }

  // Keep legacy single-alert dismiss for backwards compat
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
