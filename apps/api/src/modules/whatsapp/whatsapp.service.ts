import { HttpException, HttpStatus, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentConversationState, PaymentMethod, ReviewConversationState } from '@prisma/client';
import axios from 'axios';
import type { Response } from 'express';
import { formatInr } from '../../common/utils/currency';
import { OrderService } from '../order/order.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductService } from '../product/product.service';
import { ReviewService } from '../review/review.service';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly productService: ProductService,
    private readonly reviewService: ReviewService,
    @Inject(forwardRef(() => OrderService)) private readonly orderService: OrderService,
  ) {}

  async verifyWebhook(tenantId: string, mode: string, verifyToken: string, challenge: string, response: Response) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || !tenant.whatsappVerifyToken) {
      return response.sendStatus(403);
    }
    
    if (mode === 'subscribe' && verifyToken === tenant.whatsappVerifyToken) {
      return response.status(200).send(challenge);
    }

    return response.sendStatus(403);
  }

  async handleIncomingWebhook(tenantId: string, payload: any) {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    
    // Ignore status updates (read, delivered, etc.)
    if (value?.statuses) {
      this.logger.debug(`Status update for tenant ${tenantId}: ${value.statuses[0]?.status}`);
      return;
    }

    const message = value?.messages?.[0];
    if (!message || (!message.text?.body && !message.interactive) || !message.from) {
      this.logger.warn(`Invalid or unsupported message payload: ${JSON.stringify(payload)}`);
      return;
    }

    const customerPhone = message.from;
    let rawText = '';
    
    if (message.type === 'interactive') {
      rawText = message.interactive.button_reply?.id || message.interactive.list_reply?.id || '';
    } else {
      rawText = message.text.body.trim();
    }

    if (!rawText) return;
    this.logger.log(`Message from ${customerPhone}: ${rawText}`);

    // Business Hours Check
    const isOpen = await this.isBusinessOpen(tenantId);
    if (!isOpen) {
      const closedMsg = await this.getTemplate(tenantId, 'BUSINESS_CLOSED', 
        "We are currently closed. Please visit us during our working hours!");
      await this.sendTextMessage(tenantId, customerPhone, closedMsg);
      return;
    }

    // Order flow conversation (Step 2: Payment choice)
    const orderFlowResponse = await this.tryHandleOrderConversation(tenantId, customerPhone, rawText);
    if (orderFlowResponse) {
      if (typeof orderFlowResponse === 'string') {
        await this.sendTextMessage(tenantId, customerPhone, orderFlowResponse);
      } else {
        await this.sendInteractiveButtons(tenantId, customerPhone, orderFlowResponse.text, orderFlowResponse.buttons);
      }
      return;
    }

    // Review flow conversation
    const reviewResponse = await this.tryHandleReviewConversation(tenantId, customerPhone, rawText);
    if (reviewResponse) {
      await this.sendTextMessage(tenantId, customerPhone, reviewResponse);
      return;
    }

    const commandResponse = await this.handleCommand(tenantId, customerPhone, rawText);
    if (!commandResponse) return;

    if (typeof commandResponse === 'string') {
      this.logger.debug(`Sending text response: ${commandResponse}`);
      // Convert specific text responses to buttons if appropriate
      if (rawText.toLowerCase().startsWith('order ') && commandResponse.includes('How would you like to pay?')) {
        await this.sendInteractiveButtons(tenantId, customerPhone, commandResponse, [
          { id: '1', title: 'Pay Online' },
          { id: '2', title: 'COD' }
        ]);
      } else {
        await this.sendTextMessage(tenantId, customerPhone, commandResponse);
      }
    } else if (commandResponse.type === 'list') {
      const cr = commandResponse as any;
      this.logger.debug(`Sending list message with ${cr.sections?.length} sections`);
      await this.sendListMessage(
        tenantId, 
        customerPhone, 
        cr.body || "Please select an item to view details:",
        cr.buttonLabel || "View Products",
        cr.sections || [],
        cr.header,
        cr.footer
      );
    } else if (commandResponse.type === 'buttons') {
       const cr = commandResponse as any;
       this.logger.debug(`Sending button message with ${cr.buttons?.length} buttons`);
       await this.sendInteractiveButtons(
         tenantId, 
         customerPhone, 
         cr.text || '', 
         cr.buttons || [],
         cr.header,
         cr.footer
       );
    }
  }

  async isBusinessOpen(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant?.openTime || !tenant?.closeTime) return true; // Default to open if not set

    const timezone = tenant.timezone || 'Asia/Kolkata';
    const now = new Date();
    const localTimeStr = now.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      timeZone: timezone 
    });

    return localTimeStr >= tenant.openTime && localTimeStr <= tenant.closeTime;
  }

  async getTemplate(tenantId: string, key: string, defaultValue: string, variables: Record<string, string> = {}): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const templates = (tenant?.messageTemplates as any) || {};
    let template = templates[key] || defaultValue;

    // Basic interpolation: replace {{var}} with value
    for (const [vKey, vVal] of Object.entries(variables)) {
      template = template.replace(new RegExp(`{{${vKey}}}`, 'g'), vVal);
    }
    
    return template;
  }

  async handleCommand(tenantId: string, customerPhone: string, rawText: string) {
    const lowerText = rawText.trim().toLowerCase();

    // 1. Direct Action Commands (Stateless Button IDs)
    if (lowerText.startsWith('order_')) {
      const productId = rawText.slice(6);
      const cartStatus = await this.orderService.addToCart(tenantId, customerPhone, productId);
      return this.buildAddedToCartMessage(cartStatus);
    }

    if (lowerText === 'view_cart' || lowerText === 'cart') {
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      if (!cart || cart.items.length === 0) {
        return "Your cart is currently empty. Send 'menu' to see our delicious items!";
      }
      return this.buildCartListMessage(cart);
    }

    if (lowerText.startsWith('edit_')) {
      const productId = rawText.slice(5);
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      const item = (cart?.items || []).find(i => i.productId === productId);
      if (!item) return "Item not found in cart.";
      return this.buildEditItemMessage(item);
    }

    if (lowerText.startsWith('qty_inc_')) {
      const productId = rawText.slice(8);
      await this.orderService.incrementItemQty(tenantId, customerPhone, productId);
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      const item = (cart?.items || []).find(i => i.productId === productId);
      if (!item) return this.buildCartListMessage(cart); 
      return this.buildEditItemMessage(item);
    }

    if (lowerText.startsWith('qty_dec_')) {
      const productId = rawText.slice(8);
      await this.orderService.decrementItemQty(tenantId, customerPhone, productId);
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      const item = (cart?.items || []).find(i => i.productId === productId);
      if (!item) return this.buildCartListMessage(cart);
      return this.buildEditItemMessage(item);
    }

    if (lowerText.startsWith('remove_')) {
      const productId = rawText.slice(7);
      await this.orderService.removeItemFromCart(tenantId, customerPhone, productId);
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      if (!cart || cart.items.length === 0) return "Item removed. Your cart is now empty.";
      return this.buildCartListMessage(cart);
    }

    if (lowerText === 'empty_cart' || lowerText === 'clear_cart') {
      await this.orderService.clearCart(tenantId, customerPhone);
      return "🗑️ Your cart has been cleared. Send 'menu' to start again!";
    }

    if (lowerText === 'help') {
      return this.getTemplate(tenantId, 'HELP_TEXT', 
        ['Commands:', 'menu', 'order <item>', 'status', 'reviews <item>', 'help'].join('\n'));
    }

    if (lowerText === 'menu') {
      const products = (await this.productService.listAvailable(tenantId)) as any[];
      if (!products.length) {
        return this.getTemplate(tenantId, 'MENU_EMPTY', 'No products are available right now.');
      }

      // Get tenant's defined categories
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
      const categories = (tenant?.categories as string[]) || [];

      // If no categories defined, fallback to old "All Products" list but grouped
      if (categories.length === 0) {
        const categoriesMap = new Map<string, any[]>();
        products.forEach(p => {
          const cat = p.category || 'General';
          if (!categoriesMap.has(cat)) categoriesMap.set(cat, []);
          categoriesMap.get(cat)?.push(p);
        });

        const schema = (tenant?.productSchema as any[]) || [];
        const sections: any[] = [];
        let totalRows = 0;

        const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
        if (cart && cart.items.length > 0) {
          sections.push({
            title: '🛒 Current Cart',
            rows: [
              { id: 'VIEW_CART', title: 'View / Edit Cart', description: `${cart.count} items - ${formatInr(cart.total)}` },
              { id: 'CHECKOUT', title: 'Proceed to Checkout 💳', description: 'Finalize your order and pay' }
            ]
          });
          totalRows += 2;
        }

        const entries = Array.from(categoriesMap.entries());
        for (const [catName, items] of entries) {
          if (totalRows >= 10) break;
          
          const availableSlots = 10 - totalRows;
          const rowsInThisSection = items.slice(0, Math.min(availableSlots, 10)).map(p => {
            let prefix = '';
            if (p.attributes) {
              const attrs = p.attributes as any;
              schema.filter((f: any) => f.icon && attrs[f.name] === true).forEach((f: any) => {
                prefix += f.icon + ' ';
              });
            }
            const bestSeller = p.tags && Array.isArray(p.tags) && p.tags.includes('Best Seller') ? '⭐ ' : '';
            return {
              id: `PROD_${p.id}`,
              title: (bestSeller + prefix + p.name).slice(0, 24),
              description: `${formatInr(Number(p.price))} - ${p.description || ''}`.slice(0, 72)
            };
          });

          if (rowsInThisSection.length > 0) {
            sections.push({
              title: catName.slice(0, 24),
              rows: rowsInThisSection
            });
            totalRows += rowsInThisSection.length;
          }
        }

        return {
          type: 'list',
          body: 'Explore our catalog and add items to your cart.',
          buttonLabel: 'View Products',
          sections
        };
      }

      // Category Explorer Mode
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      const cartRows = [];
      if (cart && cart.items.length > 0) {
        cartRows.push(
          { id: 'VIEW_CART', title: 'View / Edit Cart', description: `${cart.count} items - ${formatInr(cart.total)}` },
          { id: 'CHECKOUT', title: 'Proceed to Checkout 💳' }
        );
      }

      const availableRowsForCategories = 10 - cartRows.length;
      const categoryRows = categories
        .map(cat => {
          const count = products.filter(p => p.category === cat).length;
          return { cat, count };
        })
        .filter(item => item.count > 0);

      // Add "General" if there are products with no defined category
      const generalCount = products.filter(p => !categories.includes(p.category)).length;
      if (generalCount > 0) {
        categoryRows.push({ cat: 'General', count: generalCount });
      }

      const slicedCategoryRows = categoryRows
        .slice(0, availableRowsForCategories)
        .map(item => ({
          id: `CAT_${item.cat}`,
          title: item.cat.slice(0, 24),
          description: `Explore ${item.count} items in ${item.cat}`.slice(0, 72)
        }));

      const finalSections = [];
      if (cartRows.length > 0) {
        finalSections.push({ title: '🛒 Current Cart'.slice(0, 24), rows: cartRows });
      }
      if (slicedCategoryRows.length > 0) {
        finalSections.push({ title: 'Categories'.slice(0, 24), rows: slicedCategoryRows });
      }

      return {
        type: 'list',
        header: '🍱 *Menu Explorer*',
        body: 'Select a category to explore our current offerings.',
        footer: 'Powered by OrderThru',
        buttonLabel: 'Explore Menu',
        sections: finalSections
      };
    }

    // Handle Category selection (CAT_<name>)
    if (lowerText.startsWith('cat_')) {
      const catName = rawText.slice(4);
      const products = await this.productService.listAvailable(tenantId);
      const filtered = (products as any[]).filter(p => (catName === 'General' ? !p.category : p.category === catName));

      if (filtered.length === 0) {
        return `No items found in ${catName}. Send 'menu' to see other categories.`;
      }

      // Optimization: If only one item, show it directly!
      if (filtered.length === 1) {
        return this.showProductDetails(tenantId, filtered[0]);
      }

      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
      const schema = (tenant?.productSchema as any[]) || [];

      const rows = filtered.slice(0, 10).map(p => {
        let prefix = '';
        if (p.attributes) {
          const attrs = p.attributes as any;
          schema.filter((f: any) => f.icon && attrs[f.name] === true).forEach((f: any) => {
            prefix += f.icon + ' ';
          });
        }
        return {
          id: `PROD_${p.id}`,
          title: (prefix + p.name).slice(0, 24),
          description: `${formatInr(Number(p.price))} - ${p.description || ''}`.slice(0, 72)
        };
      });

      return {
        type: 'list',
        header: `📂 *${catName}*`,
        body: `Select an item from the ${catName} category.`,
        footer: 'Click to view details and add to cart',
        buttonLabel: 'Select Item',
        sections: [{ title: catName.slice(0, 24), rows }]
      };
    }

    // Handle interactive product selection (PROD_<id>)
    if (lowerText.startsWith('prod_')) {
      const productId = rawText.slice(5);
      const product = await this.prisma.product.findUnique({ where: { id: productId } });
      if (product) {
        return this.showProductDetails(tenantId, product);
      }
    }

    // Handle "order <items...>" or bulk direct strings
    if (lowerText.startsWith('order ') || /^\d+\s+/i.test(lowerText) || lowerText.includes(',')) {
      const orderContent = lowerText.startsWith('order ') ? rawText.slice(6) : rawText;
      const parsedItems = this.parseBulkOrderText(orderContent);

      if (parsedItems.length > 0) {
        const { cart, results, errors } = await this.orderService.bulkAddToCart(tenantId, customerPhone, parsedItems);
        
        let response = `🛒 *Bulk Order Processed!*\n\n`;
        if (results.length > 0) {
          response += `*Added to Cart:*\n${results.map(r => `• ${r}`).join('\n')}\n\n`;
        }
        
        if (errors.length > 0) {
          response += `⚠️ *Not Found* (check spelling):\n${errors.map(e => `• ${e}`).join('\n')}\n\n`;
        }

        const totalItems = (cart.orderItems as any[]).reduce((acc, item) => acc + item.quantity, 0);
        response += `*Total Items:* ${totalItems}\n*Total Amount:* ${formatInr(Number(cart.totalAmount))}\n\nWhat would you like to do next?`;

        return {
          type: 'buttons',
          text: response,
          buttons: [
            { id: 'CHECKOUT', title: 'Checkout 💳' },
            { id: 'VIEW_CART', title: 'View Cart 🛒' },
            { id: 'menu', title: 'Add More ➕' }
          ]
        };
      }
    }

    if (lowerText === 'status') {
      const order = await this.orderService.getLatestOrderForCustomer(tenantId, customerPhone);
      return this.getTemplate(tenantId, 'ORDER_STATUS',
        [
          `Latest order: {{id}}`,
          `Status: {{status}}`,
          `Total: {{total}}`,
        ].join('\n'), {
          id: order.id,
          status: order.status,
          total: formatInr(Number(order.totalAmount))
        });
    }

    if (lowerText.startsWith('reviews ')) {
      const itemName = rawText.slice(8).trim();
      const summary = await this.reviewService.getReviewSummaryByItemName(tenantId, itemName);
      if (!summary.reviewCount) {
        return `No reviews yet for ${summary.product.name}.`;
      }

      const reviewLines = summary.latestReviews.map((review: { rating: number; comment: string }) => {
        return `${review.rating}/5 - ${review.comment}`;
      });

      return [
        `${summary.product.name}`,
        `Average rating: ${summary.averageRating.toFixed(1)}/5`,
        'Latest reviews:',
        ...reviewLines,
      ].join('\n');
    }


    if (lowerText === 'checkout') {
      const order = await this.orderService.finalizeOrder(tenantId, customerPhone);
      const prompt = await this.getTemplate(tenantId, 'ORDER_PAYMENT_PROMPT', 
        [
          `Great! Your order #${order.id.slice(-6).toUpperCase()} is ready.`,
          `Total: ${formatInr(Number(order.totalAmount))}`,
          '',
          'How would you like to pay?',
        ].join('\n'), { itemName: 'your order' });

      return {
        type: 'buttons',
        text: prompt,
        buttons: [
          { id: '1', title: 'Pay Online' },
          { id: '2', title: 'COD' }
        ]
      };
    }


    return 'Unknown command. Send "help" to see supported commands.';
  }

  async showProductDetails(tenantId: string, product: any) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const schema = (tenant?.productSchema as any[]) || [];

    let responseText = `*${product.name}*\n`;
    responseText += `Price: ${formatInr(Number(product.price))}\n`;
    if (product.description) responseText += `Description: ${product.description}\n`;

    if (product.attributes && typeof product.attributes === 'object') {
      const attributeLines = schema
        .filter((f: any) => {
          const applies = !f.appliesTo || f.appliesTo.length === 0 || f.appliesTo.includes(product.category);
          const val = (product.attributes as any)[f.name];
          if (f.type === 'number' && val === 0) return false;
          return applies && val !== undefined && val !== null && val !== '';
        })
        .map((f: any) => {
          const val = (product.attributes as any)[f.name];
          let displayVal = val;
          if (f.type === 'number' && f.options && Array.isArray(f.options)) {
            displayVal = f.options[val] || val;
          }
          let iconPrefix = f.icon ? f.icon + ' ' : '';
          if (f.icon === '🌶️' && f.type === 'number' && typeof val === 'number') {
            iconPrefix = '🌶️'.repeat(val) + ' ';
          }
          return `${iconPrefix}${f.label || f.name}: ${displayVal}`;
        });

      if (attributeLines.length > 0) {
        responseText += `\nAttributes:\n${attributeLines.join('\n')}`;
      }
    }

    if (product.tags && Array.isArray(product.tags) && product.tags.length > 0) {
      responseText += `\n\n🔖 Tags: ${product.tags.join(', ')}`;
    }

    return {
      type: 'buttons',
      text: responseText,
      buttons: [
        { id: `ORDER_${product.id}`, title: 'Add to Cart ➕' },
        { id: 'VIEW_CART', title: 'View Cart 🛒' },
        { id: 'menu', title: 'Back to Menu' }
      ]
    };
  }

  private parseBulkOrderText(text: string): { name: string; quantity: number }[] {
    const items: { name: string; quantity: number }[] = [];
    
    // Split by common delimiters like comma, newline, or semicolon
    const segments = text.split(/,|\n|;/);
    
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;

      // Pattern 1: "2 Coffee" or "2x Coffee"
      const match1 = trimmed.match(/^(\d+)\s*(?:x|X)?\s*(.+)$/);
      if (match1) {
        items.push({ quantity: parseInt(match1[1], 10), name: match1[2].trim() });
        continue;
      }

      // Pattern 2: "Coffee x2" or "Coffee 2"
      const match2 = trimmed.match(/^(.+?)\s*(?:x|X)?\s*(\d+)$/);
      if (match2) {
        items.push({ quantity: parseInt(match2[2], 10), name: match2[1].trim() });
        continue;
      }

      // Pattern 3: Just "Coffee" (assume 1)
      if (trimmed.length > 2) {
        items.push({ quantity: 1, name: trimmed });
      }
    }
    
    return items;
  }

  async tryHandleOrderConversation(tenantId: string, customerPhone: string, rawText: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        tenantId,
        customerPhone,
        paymentConversation: PaymentConversationState.WAITING_FOR_METHOD,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!order) return null;

    const lowerText = rawText.trim();
    if (lowerText === '1' || lowerText === 'online') {
      const updated = await this.orderService.finalizeOrderPaymentMethod(tenantId, order.id, PaymentMethod.ONLINE);
      return this.orderService.formatOrderConfirmation({
        ...updated,
        totalAmount: Number(updated.totalAmount),
      });
    }

    if (lowerText === '2' || lowerText === 'cod') {
      const updated = await this.orderService.finalizeOrderPaymentMethod(tenantId, order.id, PaymentMethod.COD);
      return this.orderService.formatOrderConfirmation({
        ...updated,
        totalAmount: Number(updated.totalAmount),
      });
    }

    return {
      text: 'Please select a valid payment method:',
      buttons: [
        { id: '1', title: 'Pay Online' },
        { id: '2', title: 'COD' }
      ]
    };
  }

  async tryHandleReviewConversation(tenantId: string, customerPhone: string, rawText: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: tenantId,
        customerPhone,
        reviewConversation: {
          in: [ReviewConversationState.WAITING_FOR_RATING, ReviewConversationState.WAITING_FOR_COMMENT],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!order) {
      return null;
    }

    if (order.reviewConversation === ReviewConversationState.WAITING_FOR_RATING) {
      const rating = Number.parseInt(rawText, 10);
      if (Number.isNaN(rating) || rating < 1 || rating > 5) {
        return 'Please reply with a rating from 1 to 5.';
      }

      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          reviewConversation: ReviewConversationState.WAITING_FOR_COMMENT,
          pendingReviewRating: rating,
        },
      });

      return 'Write a short review';
    }

    if (!order.pendingReviewRating) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          reviewConversation: ReviewConversationState.WAITING_FOR_RATING,
        },
      });
      return 'Please rate your order first (1-5).';
    }

    await this.reviewService.createReviewsForOrder(tenantId, order.id, order.pendingReviewRating, rawText);
    return 'Thanks for your feedback.';
  }

  async sendInteractiveButtons(tenantId: string, to: string, bodyText: string, buttons: Array<{ id: string, title: string }>, headerText?: string, footerText?: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return;

    const phoneNumberId = tenant.whatsappPhoneNumberId;
    const accessToken = tenant.whatsappAccessToken;
    const apiVersion = tenant.whatsappApiVersion || this.configService.get<string>('WHATSAPP_API_VERSION') || 'v20.0';

    if (!phoneNumberId || !accessToken) return;

    try {
      await axios.post(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive: {
            type: 'button',
            header: headerText ? { type: 'text', text: headerText } : undefined,
            body: { text: bodyText },
            footer: footerText ? { text: footerText } : undefined,
            action: {
              buttons: buttons.map(btn => ({
                type: 'reply',
                reply: { id: btn.id, title: btn.title }
              }))
            }
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      this.logger.log(`Interactive buttons sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send interactive buttons: ${JSON.stringify(error.response?.data || error.message)}`);
    }
  }

  async sendListMessage(tenantId: string, to: string, bodyText: string, buttonLabel: string, sections: any[], headerText?: string, footerText?: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return;

    const phoneNumberId = tenant.whatsappPhoneNumberId;
    const accessToken = tenant.whatsappAccessToken;
    const apiVersion = tenant.whatsappApiVersion || this.configService.get<string>('WHATSAPP_API_VERSION') || 'v20.0';

    if (!phoneNumberId || !accessToken) return;

    try {
      this.logger.debug(`Preparing list message for ${to} with ${sections.length} sections`);

      // Sanitization helper
      const clean = (str: string, limit: number, fallback = '...') => {
        let val = (str || '').replace(/[*_~`]/g, '').trim(); 
        if (!val) val = fallback;
        return val.slice(0, limit);
      };

      const sectionTitles = new Set<string>();
      const rowIds = new Set<string>();
      let totalRows = 0;
      const validSections = [];

      for (const section of sections) {
        if (totalRows >= 10) break;

        // 1. Sanitize & Ensure Unique Section Title
        let sTitle = clean(section.title, 24, 'Section');
        let counter = 1;
        while (sectionTitles.has(sTitle)) {
          const suffix = ` (${counter})`;
          sTitle = clean(section.title.slice(0, 24 - suffix.length) + suffix, 24);
          counter++;
        }
        sectionTitles.add(sTitle);

        // 2. Process Rows
        const safeRows = [];
        const rowsToProcess = (section.rows || []).slice(0, 10 - totalRows);
        
        for (const row of rowsToProcess) {
          // Ensure Unique Row ID
          let rId = row.id || `row_${Math.random().toString(36).slice(2, 7)}`;
          if (rowIds.has(rId)) {
            rId = `${rId.slice(0, 190)}_${Math.random().toString(36).slice(2, 7)}`;
          }
          rowIds.add(rId);

          safeRows.push({
            id: rId,
            title: clean(row.title, 24, 'Item'),
            description: row.description ? clean(row.description, 72) : undefined
          });
        }

        // 3. Only add section if it has rows
        if (safeRows.length > 0) {
          validSections.push({
            title: sTitle,
            rows: safeRows
          });
          totalRows += safeRows.length;
        }
      }

      if (validSections.length === 0) {
        this.logger.warn(`No valid sections/rows for list message to ${to}. Falling back to text.`);
        await this.sendTextMessage(tenantId, to, bodyText);
        return;
      }

      this.logger.debug(`Sending list message request to WhatsApp API with ${totalRows} rows...`);
      const response = await axios.post(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: headerText ? { type: 'text', text: clean(headerText, 60) } : undefined,
            body: { text: clean(bodyText, 1024, 'Please select:') },
            footer: footerText ? { text: clean(footerText, 60) } : undefined,
            action: {
              button: clean(buttonLabel, 20, 'View Options'),
              sections: validSections
            }
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      this.logger.log(`List message sent to ${to}: ${response.status}`);
    } catch (error: any) {
      this.logger.error(`Failed to send list message: ${JSON.stringify(error.response?.data || error.message)}`);
    }
  }

  async sendTextMessage(tenantId: string, to: string, text: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      this.logger.warn(`Tenant ${tenantId} not found. Message aborted.`);
      return;
    }

    const phoneNumberId = tenant.whatsappPhoneNumberId;
    const accessToken = tenant.whatsappAccessToken;
    const apiVersion = tenant.whatsappApiVersion || this.configService.get<string>('WHATSAPP_API_VERSION') || 'v20.0';

    if (!phoneNumberId || !accessToken) {
      this.logger.warn(`WhatsApp credentials missing for tenant ${tenantId}. Message to ${to}: ${text}`);
      return;
    }

    try {
      this.logger.log(`Sending message to ${to} via ${phoneNumberId}`);
      await axios.post(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      this.logger.log(`Message sent successfully to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send WhatsApp message to ${to}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
      throw new HttpException('Failed to send WhatsApp message', HttpStatus.BAD_GATEWAY);
    }
  }

  async buildAddedToCartMessage(cart: any) {
    const totalItems = (cart.orderItems || []).reduce((acc: number, item: any) => acc + item.quantity, 0);
    return {
      type: 'buttons',
      text: `✅ *Added to Cart!*\n\n*Cart Total:* ${formatInr(Number(cart.totalAmount))}\n*Items in Cart:* ${totalItems}`,
      buttons: [
        { id: 'menu', title: 'Add More ➕' },
        { id: 'VIEW_CART', title: 'View Cart 🛒' },
        { id: 'CHECKOUT', title: 'Checkout 💳' }
      ]
    };
  }

  async buildCartListMessage(cart: any) {
    const items = cart.items || [];
    const rows = items.slice(0, 7).map((item: any) => ({
      id: `EDIT_${item.productId}`,
      title: `✏️ Edit ${item.name} x${item.quantity}`,
      description: `${formatInr(item.unitPrice)} ea | Sub: ${formatInr(item.subtotal)}`
    }));

    // Add action rows
    rows.push(
      { id: 'menu', title: '➕ Add More Items', description: 'Browse categories and items' },
      { id: 'CHECKOUT', title: '✅ Proceed to Checkout', description: `Total: ${formatInr(cart.total)}` },
      { id: 'EMPTY_CART', title: '🗑️ Empty Cart', description: 'Remove all items' }
    );

    return {
      type: 'list',
      header: '🛒 *Your Shopping Cart*',
      body: `Items: ${cart.count}\nSubtotal: ${formatInr(cart.subtotal)}\nTax (5%): ${formatInr(cart.tax)}\n*Total: ${formatInr(cart.total)}*`,
      footer: 'Select an item to edit quantity or proceed to checkout',
      buttonLabel: 'View Cart Options',
      sections: [{ title: 'Cart Management', rows }]
    };
  }

  async buildEditItemMessage(item: any) {
    const text = `*Editing: ${item.name}*\n\nQty: ${item.quantity}\nPrice: ${formatInr(item.unitPrice)}\nSubtotal: ${formatInr(item.subtotal)}`;
    
    const buttons = [];
    buttons.push({ id: `QTY_INC_${item.productId}`, title: 'Add 1 ➕' });
    
    if (item.quantity > 1) {
      buttons.push({ id: `QTY_DEC_${item.productId}`, title: 'Remove 1 ➖' });
    } else {
      buttons.push({ id: `REMOVE_${item.productId}`, title: 'Remove Item 🗑️' });
    }

    buttons.push({ id: 'VIEW_CART', title: 'View Cart 🛒' });

    return {
      type: 'buttons',
      text,
      buttons: buttons.slice(0, 3) // Max 3
    };
  }
}
