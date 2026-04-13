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

  async searchProducts(tenantId: string, query: string, limit: number = 3) {
    const sanitizedQuery = query.trim().replace(/[^\w\s]/gi, '');
    if (!sanitizedQuery) return [];

    // Layered search:
    // 1. Exact name match (highest priority)
    // 2. Typos & similarity match (via pg_trgm)
    // 3. Tag match (JSONB path search)
    // 4. Levenshtein distance (for short query robustness)
    
    const results = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT 
        p.*,
        CAST(similarity(name, $1) AS FLOAT) as similarity_score,
        levenshtein(LOWER(name), LOWER($1)) as distance
      FROM "Product" p
      WHERE 
        "tenantId" = $2 AND "isAvailable" = true
        AND (
          name ILIKE $3 -- Partial name
          OR name % $1 -- Similarity (trigram)
          OR tags::text ILIKE $4 -- Tag search
          OR ($5::int < 3 AND levenshtein(LOWER(name), LOWER($1)) < 3) -- Levenshtein for short typos
        )
      ORDER BY 
        CASE WHEN name ILIKE $1 THEN 1 ELSE 2 END,
        similarity_score DESC,
        distance ASC
      LIMIT $6
    `, 
      sanitizedQuery, 
      tenantId, 
      `%${sanitizedQuery}%`, 
      `%${sanitizedQuery}%`,
      sanitizedQuery.length,
      limit
    );

    return results.map(p => ({
      ...p,
      price: Number(p.price),
      similarity: Number(p.similarity_score || 0)
    }));
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

  async addToCart(tenantId: string, customerPhone: string, productId: string, quantityToAdd: number = 1) {
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
        const newQty = Math.min(10, existingItem.quantity + quantityToAdd);
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
            quantity: Math.min(10, quantityToAdd),
            unitPrice: product.price,
            taxAmount: (Number(product.price) * Math.min(10, quantityToAdd)) * taxRate
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

  // Deprecated bulkAddToCart removed

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

  listOrders(tenantId: string, filters?: { status?: OrderStatus, startDate?: string, endDate?: string, phone?: string }) {
    const where: any = {
      tenantId,
      status: { not: OrderStatus.DRAFT }
    };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = new Date(filters.startDate);
      if (filters.endDate) where.createdAt.lte = new Date(filters.endDate);
    }

    if (filters?.phone) {
      where.customerPhone = { contains: filters.phone };
    }

    return this.prisma.order.findMany({
      where,
      include: {
        orderItems: {
          include: { product: true },
        },
        reviews: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private maskOrderId(id: string) {
    return `#${id.slice(-7).toUpperCase()}`;
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
      `Your order ${this.maskOrderId(updated.id)} is now ${updated.status}.`,
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
      `Order confirmed: ${this.maskOrderId(order.id)}`,
      `Items: ${items}`,
      `Total: ${formatInr(order.totalAmount)}`,
      `Status: ${order.status}`,
      order.paymentLinkUrl ? `Pay here: ${order.paymentLinkUrl}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private formatDetailedInvoice(order: any, discount: number = 0, notes?: string) {
    const lines: string[] = [];
    lines.push(`🍴 *Order Invoice: ${this.maskOrderId(order.id)}*`);
    lines.push(``);

    let subtotal = 0;
    let totalTax = 0;

    order.orderItems.forEach((item: any) => {
      const itemPrice = Number(item.unitPrice);
      const itemSubtotal = itemPrice * item.quantity;
      const itemTax = Number(item.taxAmount);
      
      subtotal += itemSubtotal;
      totalTax += itemTax;

      lines.push(`- ${item.product.name} x${item.quantity}: ${formatInr(itemSubtotal)} ${itemTax > 0 ? `(Tax: ${formatInr(itemTax)})` : '(No Tax)'}`);
    });

    lines.push(``);
    lines.push(`-------------------------`);
    lines.push(`Subtotal: ${formatInr(subtotal)}`);
    if (totalTax > 0) lines.push(`Total Tax: ${formatInr(totalTax)}`);
    if (discount > 0) lines.push(`Discount: -${formatInr(discount)}`);
    lines.push(`-------------------------`);
    lines.push(`*TOTAL: ${formatInr(Number(order.totalAmount))}*`);

    if (notes) {
      lines.push(``);
      lines.push(`Notes: ${notes}`);
    }
    
    lines.push(`-------------------------`);
    lines.push(`Thank you for ordering!`);

    return lines.join('\n');
  }

  async createManualOrder(tenantId: string, customerPhone: string, items: Array<{ productId: string; quantity: number; taxRate?: number }>, discount: number = 0, notes?: string) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      const defaultRate = Number(this.configService.get('DEFAULT_TAX_RATE')) || 0.05;
      const tenantTaxRate = tenant?.taxRate ? Number(tenant.taxRate) : defaultRate;

      // 1. Create the base order
      const order = await tx.order.create({
        data: {
          tenantId,
          customerPhone,
          status: OrderStatus.PENDING,
          totalAmount: 0, 
          paymentMethod: PaymentMethod.COD,
          source: 'MANUAL',
          discountAmount: discount,
          notes,
        },
      });

      // 2. Fetch products and create items
      let subtotalPlusTax = 0;
      for (const itemInput of items) {
        const product = await tx.product.findUnique({ where: { id: itemInput.productId } });
        if (!product || product.tenantId !== tenantId) continue;

        const itemSubtotal = Number(product.price) * itemInput.quantity;
        const itemTaxRate = (itemInput.taxRate !== undefined && itemInput.taxRate !== null) ? itemInput.taxRate : tenantTaxRate;
        const itemTax = itemSubtotal * itemTaxRate;
        
        subtotalPlusTax += itemSubtotal + itemTax;

        await tx.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            quantity: itemInput.quantity,
            unitPrice: product.price,
            taxAmount: itemTax,
          },
        });
      }

      const totalAmount = Math.max(0, subtotalPlusTax - discount);

      // 3. Update total
      const finalizedOrder = await tx.order.update({
        where: { id: order.id },
        data: { totalAmount },
        include: {
          orderItems: { include: { product: true } },
        },
      });

      // 4. Notify Dashboard
      this.eventsGateway.emitNewOrder(tenantId, finalizedOrder);

      // 5. Send WhatsApp Message
      const invoiceMsg = this.formatDetailedInvoice(finalizedOrder, discount, notes);
      await this.whatsAppService.sendTextMessage(tenantId, customerPhone, invoiceMsg);

      return finalizedOrder;
    });
  }
}
