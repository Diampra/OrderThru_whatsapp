import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class AbandonedCartService {
  private readonly logger = new Logger(AbandonedCartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  /**
   * Runs every 15 minutes.
   * Finds DRAFT orders with items that haven't been touched in 30+ minutes.
   * Creates a StaffAlert and emits a WebSocket notification.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async detectAbandonedCarts() {
    this.logger.log('Running abandoned cart detection...');

    const cutoffTime = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago

    const abandonedCarts = await this.prisma.order.findMany({
      where: {
        status: 'DRAFT',
        updatedAt: { lt: cutoffTime },
        orderItems: { some: {} }, // must have at least one item
      },
      include: {
        orderItems: {
          include: { product: true },
        },
      },
    });

    this.logger.log(`Found ${abandonedCarts.length} abandoned cart(s).`);

    for (const cart of abandonedCarts) {
      // Check if we already created an alert for this cart in the last 2 hours
      const recentAlert = await this.prisma.staffAlert.findFirst({
        where: {
          tenantId: cart.tenantId,
          customerPhone: cart.customerPhone,
          reason: { startsWith: 'Abandoned cart' },
          createdAt: { gt: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // within 2 hrs
        },
      });

      if (recentAlert) continue; // Skip duplicates

      const itemList = cart.orderItems
        .map((i: any) => `${i.quantity}x ${i.product.name}`)
        .join(', ');

      const reason = `Abandoned cart: ${itemList}. Customer left without checking out.`;

      // Persist to DB
      await this.prisma.staffAlert.create({
        data: {
          tenantId: cart.tenantId,
          customerPhone: cart.customerPhone,
          reason,
        },
      });

      // Notify dashboard via WebSocket
      this.eventsGateway.emitStaffNotification(
        cart.tenantId,
        cart.customerPhone,
        reason,
      );

      this.logger.log(
        `Abandoned cart alert created for ${cart.customerPhone} (${cart.tenantId})`,
      );
    }
  }
}
