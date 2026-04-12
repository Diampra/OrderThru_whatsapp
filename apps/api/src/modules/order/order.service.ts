import { BadRequestException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { OrderStatus, PaymentConversationState, PaymentMethod, ReviewConversationState } from '@prisma/client';
import { formatInr } from '../../common/utils/currency';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductService } from '../product/product.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

import { EventsGateway } from '../events/events.gateway';

import { ConfigService } from '@nestjs/config';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly productService: ProductService,
    private readonly paymentService: PaymentService,
    private readonly eventsGateway: EventsGateway,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsAppService: WhatsAppService,
  ) {}

  async getDetailedCart(tenantId: string, customerPhone: string) {
    const cart = await this.prisma.order.findFirst({
      where: { 
        tenantId, 
        customerPhone, 
        status: OrderStatus.DRAFT 
      },
      include: {
        orderItems: {
          include: {
            product: true,
          },
          orderBy: { createdAt: 'asc' }
        },
      },
    });

    if (!cart) return null;

    const subtotal = cart.orderItems.reduce((acc, item) => acc + (Number(item.unitPrice) * item.quantity), 0);
    const totalTax = cart.orderItems.reduce((acc, item) => acc + Number(item.taxAmount), 0);
    const count = cart.orderItems.reduce((acc, item) => acc + item.quantity, 0);

    return {
      ...cart,
      subtotal,
      tax: totalTax,
      total: Number(cart.totalAmount),
      count,
      items: cart.orderItems.map(item => ({
        productId: item.productId,
        name: item.product.name,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        taxAmount: Number(item.taxAmount),
        subtotal: Number(item.unitPrice) * item.quantity
      }))
    };
  }

  async incrementItemQty(tenantId: string, customerPhone: string, productId: string) {
    return this.applyQtyChange(tenantId, customerPhone, productId, 1);
  }

  async decrementItemQty(tenantId: string, customerPhone: string, productId: string) {
    return this.applyQtyChange(tenantId, customerPhone, productId, -1);
  }

  private async applyQtyChange(tenantId: string, customerPhone: string, productId: string, delta: number) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      const defaultRate = Number(this.configService.get('DEFAULT_TAX_RATE')) || 0.05;
      const taxRate = tenant?.taxRate ? Number(tenant.taxRate) : defaultRate;

      const cart = await tx.order.findFirst({
        where: { tenantId, customerPhone, status: OrderStatus.DRAFT },
        include: { orderItems: true }
      });

      if (!cart) throw new NotFoundException('Cart not found');

      const item = cart.orderItems.find(oi => oi.productId === productId);
      if (!item && delta < 0) throw new NotFoundException('Item not in cart');
      
      if (!item && delta > 0) {
        // Fallback to addToCart logic if item doesn't exist? 
        // For Phase 1 we assume inc/dec only works on existing items.
        return this.addToCart(tenantId, customerPhone, productId); // Re-routing if item missing?
      }

      const newQty = (item?.quantity || 0) + delta;

      if (newQty > 10) return cart; // Cap at 10 as per requirements
      
      if (newQty <= 0) {
        await tx.orderItem.delete({ where: { id: item!.id } });
      } else {
        const newTaxAmount = (Number(item!.unitPrice) * newQty) * taxRate;
        await tx.orderItem.update({
          where: { id: item!.id },
          data: { 
            quantity: newQty,
            taxAmount: newTaxAmount
          }
        });
      }

      // Recalculate total
      const updatedItems = await tx.orderItem.findMany({ where: { orderId: cart.id } });
      const newTotal = updatedItems.reduce((acc: number, oi: any) => {
        const itemTax = (Number(oi.unitPrice) * oi.quantity) * taxRate;
        return acc + (Number(oi.unitPrice) * oi.quantity) + itemTax;
      }, 0);

      return tx.order.update({
        where: { id: cart.id },
        data: { totalAmount: newTotal },
        include: { orderItems: { include: { product: true } } }
      });
    });
  }

  async removeItemFromCart(tenantId: string, customerPhone: string, productId: string) {
    const cart = await this.getCart(tenantId, customerPhone);
    if (!cart) return;

    const item = cart.orderItems.find((oi: any) => oi.productId === productId);
    if (item) {
      await this.prisma.orderItem.delete({ where: { id: item.id } });
      
      // Update cart total
      const updatedItems = await this.prisma.orderItem.findMany({ where: { orderId: cart.id } });
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
      const taxRate = tenant?.taxRate ? Number(tenant.taxRate) : 0.05;

      const newTotal = updatedItems.reduce((acc: number, oi: any) => {
        const itemTax = (Number(oi.unitPrice) * oi.quantity) * taxRate;
        return acc + (Number(oi.unitPrice) * oi.quantity) + itemTax;
      }, 0);

      await this.prisma.order.update({
        where: { id: cart.id },
        data: { totalAmount: newTotal }
      });
    }
  }

  private async getCart(tenantId: string, customerPhone: string) {
    return this.prisma.order.findFirst({
      where: { 
        tenantId, 
        customerPhone, 
        status: OrderStatus.DRAFT 
      },
      include: {
        orderItems: {
          include: {
            product: true,
          },
        },
      },
    });
  }

  async clearCart(tenantId: string, customerPhone: string) {
    const cart = await this.getCart(tenantId, customerPhone);
    if (cart) {
      await this.prisma.order.delete({ where: { id: cart.id } });
    }
  }

  async addToCart(tenantId: string, customerPhone: string, productId: string) {
    const product = await this.productService.getById(tenantId, productId);
    
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      const defaultRate = Number(this.configService.get('DEFAULT_TAX_RATE')) || 0.05;
      const taxRate = tenant?.taxRate ? Number(tenant.taxRate) : defaultRate;

      let cart = await tx.order.findFirst({
        where: { tenantId, customerPhone, status: OrderStatus.DRAFT },
        include: { orderItems: true }
      });

      if (!cart) {
        cart = await tx.order.create({
          data: {
            tenantId,
            customerPhone,
            status: OrderStatus.DRAFT,
            totalAmount: 0,
          },
          include: { orderItems: true },
        });
      }

      const existingItem = cart.orderItems.find(item => item.productId === product.id);

      if (existingItem) {
        if (existingItem.quantity >= 10) return cart;
        const newQty = existingItem.quantity + 1;
        await tx.orderItem.update({
          where: { id: existingItem.id },
          data: { 
            quantity: newQty,
            taxAmount: (Number(product.price) * newQty) * taxRate
          },
        });
      } else {
        await tx.orderItem.create({
          data: {
            orderId: cart.id,
            productId: product.id,
            quantity: 1,
            unitPrice: product.price,
            taxAmount: Number(product.price) * taxRate
          },
        });
      }

      // Refresh and update total
      const updatedItems = await tx.orderItem.findMany({ where: { orderId: cart.id } });
      const total = updatedItems.reduce((acc: number, item: any) => {
        const itemTax = (Number(item.unitPrice) * item.quantity) * taxRate;
        return acc + (Number(item.unitPrice) * item.quantity) + itemTax;
      }, 0);

      return tx.order.update({
        where: { id: cart.id },
        data: { totalAmount: total },
        include: { orderItems: { include: { product: true } } },
      });
    });
  }

  async bulkAddToCart(tenantId: string, customerPhone: string, items: { name: string; quantity: number }[]) {
    let cart = await this.getCart(tenantId, customerPhone);

    if (!cart) {
      cart = await this.prisma.order.create({
        data: {
          tenantId,
          customerPhone,
          status: OrderStatus.DRAFT,
          totalAmount: 0,
        },
        include: { orderItems: { include: { product: true } } },
      });
    }

    const results: string[] = [];
    const errors: string[] = [];

    for (const item of items) {
      const product = await this.productService.findByName(tenantId, item.name);
      if (!product) {
        errors.push(item.name);
        continue;
      }

      const existingItem = (cart.orderItems as any[]).find(oi => oi.productId === product.id);

      if (existingItem) {
        await this.prisma.orderItem.update({
          where: { id: existingItem.id },
          data: { quantity: { increment: item.quantity } },
        });
      } else {
        await this.prisma.orderItem.create({
          data: {
            orderId: cart.id,
            productId: product.id,
            quantity: item.quantity,
            unitPrice: product.price,
          },
        });
      }
      results.push(`${item.quantity}x ${product.name}`);
    }

    // Refresh cart and update total
    const updatedCart = await this.prisma.order.findUnique({
      where: { id: cart.id },
      include: { orderItems: true },
    });

    const total = updatedCart!.orderItems.reduce((acc: number, item: any) => {
      return acc + (Number(item.unitPrice) * item.quantity);
    }, 0);

    const finalCart = await this.prisma.order.update({
      where: { id: cart.id },
      data: { totalAmount: total },
      include: { orderItems: { include: { product: true } } },
    });

    return { cart: finalCart, results, errors };
  }

  async finalizeOrder(tenantId: string, customerPhone: string) {
    const cart = await this.getCart(tenantId, customerPhone);
    if (!cart || cart.orderItems.length === 0) {
      throw new BadRequestException('Your cart is empty.');
    }

    const order = await this.prisma.order.update({
      where: { id: cart.id },
      data: {
        status: OrderStatus.PENDING,
        paymentConversation: PaymentConversationState.WAITING_FOR_METHOD,
      },
      include: {
        orderItems: {
          include: {
            product: true,
          },
        },
      },
    });

    // Notify Dashboard
    this.eventsGateway.emitNewOrder(tenantId, order);

    return order;
  }

  async createOrderFromItemName(tenantId: string, customerPhone: string, itemName: string) {
    // Legacy support or quick checkout - now just uses addToCart then finalize
    await this.addToCart(tenantId, customerPhone, itemName);
    return this.finalizeOrder(tenantId, customerPhone);
  }

  async finalizeOrderPaymentMethod(tenantId: string, orderId: string, method: PaymentMethod) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        orderItems: { include: { product: true } },
      },
    });

    if (!order || order.tenantId !== tenantId) {
      throw new NotFoundException('Order not found');
    }

    if (method === PaymentMethod.ONLINE) {
      try {
        const paymentLink = await this.paymentService.createPaymentLink(tenantId, {
          orderId: order.id,
          amount: Number(order.totalAmount),
          customerPhone: order.customerPhone,
          description: `Order ${order.id}`,
        });

        return this.prisma.order.update({
          where: { id: order.id },
          data: {
            paymentMethod: PaymentMethod.ONLINE,
            paymentConversation: PaymentConversationState.NONE,
            paymentLinkId: paymentLink.id,
            paymentLinkUrl: paymentLink.short_url,
          },
          include: { orderItems: { include: { product: true } } },
        });
      } catch (error) {
        // Fallback to COD if online payment creation fails
        return this.prisma.order.update({
          where: { id: order.id },
          data: {
            paymentMethod: PaymentMethod.COD,
            paymentConversation: PaymentConversationState.NONE,
          },
          include: { orderItems: { include: { product: true } } },
        });
      }
    }

    return this.prisma.order.update({
      where: { id: order.id },
      data: {
        paymentMethod: PaymentMethod.COD,
        paymentConversation: PaymentConversationState.NONE,
      },
      include: { orderItems: { include: { product: true } } },
    });
  }

  async getLatestOrderForCustomer(tenantId: string, customerPhone: string) {
    const order = await this.prisma.order.findFirst({
      where: { tenantId, customerPhone },
      orderBy: { createdAt: 'desc' },
      include: {
        orderItems: {
          include: { product: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('No orders found for this customer.');
    }

    return order;
  }

  listOrders(tenantId: string) {
    return this.prisma.order.findMany({
      where: { 
        tenantId,
        status: { not: OrderStatus.DRAFT }
      },
      include: {
        orderItems: {
          include: { product: true },
        },
        reviews: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(tenantId: string, orderId: string, status: OrderStatus) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order || order.tenantId !== tenantId) {
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
          include: { product: true },
        },
      },
    });

    await this.whatsAppService.sendTextMessage(
      tenantId,
      updated.customerPhone,
      `Your order ${updated.id} is now ${updated.status}.`,
    );

    if (status === OrderStatus.COMPLETED) {
      await this.whatsAppService.sendTextMessage(tenantId, updated.customerPhone, 'Rate your order (1-5)');
    }

    return updated;
  }

  formatOrderConfirmation(order: {
    id: string;
    totalAmount: number;
    status: OrderStatus;
    paymentLinkUrl: string | null;
    orderItems: Array<{ product: { name: string } }>;
  }) {
    const items = order.orderItems.map((orderItem) => orderItem.product.name).join(', ');

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
