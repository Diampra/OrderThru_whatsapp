import { Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { OrderStatus, ReviewConversationState } from '@prisma/client';
import { formatInr } from '../../common/utils/currency';
import { MenuService } from '../menu/menu.service';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menuService: MenuService,
    private readonly paymentService: PaymentService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsAppService: WhatsAppService,
  ) {}

  async createOrderFromItemName(customerPhone: string, itemName: string) {
    const menuItem = await this.menuService.findByName(itemName);
    if (!menuItem) {
      throw new NotFoundException(`Menu item "${itemName}" not found or unavailable.`);
    }

    const order = await this.prisma.order.create({
      data: {
        customerPhone,
        totalAmount: menuItem.price,
        orderItems: {
          create: {
            itemId: menuItem.id,
            quantity: 1,
            unitPrice: menuItem.price,
          },
        },
      },
      include: {
        orderItems: {
          include: {
            item: true,
          },
        },
      },
    });

    const paymentLink = await this.paymentService.createPaymentLink({
      orderId: order.id,
      amount: Number(menuItem.price),
      customerPhone,
      description: `Payment for order ${order.id}`,
    });

    return this.prisma.order.update({
      where: { id: order.id },
      data: {
        paymentLinkId: paymentLink.id,
        paymentLinkUrl: paymentLink.short_url,
      },
      include: {
        orderItems: {
          include: {
            item: true,
          },
        },
      },
    });
  }

  async getLatestOrderForCustomer(customerPhone: string) {
    const order = await this.prisma.order.findFirst({
      where: { customerPhone },
      orderBy: { createdAt: 'desc' },
      include: {
        orderItems: {
          include: { item: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('No orders found for this customer.');
    }

    return order;
  }

  listOrders() {
    return this.prisma.order.findMany({
      include: {
        orderItems: {
          include: { item: true },
        },
        reviews: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(orderId: string, status: OrderStatus) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status,
        reviewConversation:
          status === OrderStatus.COMPLETED ? ReviewConversationState.WAITING_FOR_RATING : order.reviewConversation,
      },
      include: {
        orderItems: {
          include: { item: true },
        },
      },
    });

    await this.whatsAppService.sendTextMessage(
      updated.customerPhone,
      `Your order ${updated.id} is now ${updated.status}.`,
    );

    if (status === OrderStatus.COMPLETED) {
      await this.whatsAppService.sendTextMessage(updated.customerPhone, 'Rate your order (1-5)');
    }

    return updated;
  }

  formatOrderConfirmation(order: {
    id: string;
    totalAmount: number;
    status: OrderStatus;
    paymentLinkUrl: string | null;
    orderItems: Array<{ item: { name: string } }>;
  }) {
    const items = order.orderItems.map((orderItem) => orderItem.item.name).join(', ');

    return [
      `Order confirmed: ${order.id}`,
      `Items: ${items}`,
      `Total: ${formatInr(order.totalAmount)}`,
      `Status: ${order.status}`,
      order.paymentLinkUrl ? `Pay here: ${order.paymentLinkUrl}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }
}
