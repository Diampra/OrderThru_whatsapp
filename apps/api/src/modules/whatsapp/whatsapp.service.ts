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
import { WhatsAppSessionService } from './whatsapp-session.service';
import { EventsGateway } from '../events/events.gateway';
import { WhatsappStickerService } from '../whatsapp-sticker/whatsapp-sticker.service';
import { extractFoodName } from './food-keywords';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly productService: ProductService,
    private readonly reviewService: ReviewService,
    private readonly sessionService: WhatsAppSessionService,
    private readonly eventsGateway: EventsGateway,
    private readonly stickerService: WhatsappStickerService,
    @Inject(forwardRef(() => OrderService)) private readonly orderService: OrderService,
  ) { }

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
    if (value?.statuses) return;

    const message = value?.messages?.[0];
    if (!message || !message.from) return;

    const customerPhone = message.from;

    // Fetch tenant and check bot toggle
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const isBotEnabled = tenant?.isBotEnabled ?? true;

    // 1. If Bot is OFF, notify staff and exit (Manual Chat Mode)
    if (!isBotEnabled) {
      await this.logMessage(tenantId, customerPhone, 'USER', value?.messages?.[0]?.text?.body || '[Interactive/Media]');
      const reason = `Manual Chat Required: Bot is disabled. New message from ${customerPhone}`;
      await this.prisma.staffAlert.create({
        data: { tenantId, customerPhone, reason }
      });
      this.eventsGateway.emitStaffNotification(tenantId, customerPhone, reason);
      return;
    }

    const isPaused = await this.sessionService.isPaused(tenantId, customerPhone);
    const messageType = message.type;

    let rawText = '';
    if (messageType === 'interactive') {
      rawText = message.interactive.button_reply?.id || message.interactive.list_reply?.id || '';
    } else if (messageType === 'text') {
      rawText = message.text.body.trim();
    }

    // 1. Special Handling: Resume Bot
    if (rawText === 'RESUME_BOT') {
      await this.sessionService.resumeBot(tenantId, customerPhone);
      await this.logMessage(tenantId, customerPhone, 'USER', 'RESUME_BOT');
      await this.sendTextMessage(tenantId, customerPhone, "Welcome back! 🥘 I'm ready to take your order again.");
      return;
    }

    // 2. Pause Handling (Rule #3)
    if (isPaused) {
      this.logger.debug(`Bot is paused for ${customerPhone}. Ignoring message.`);
      return; // Stay silent
    }

    // Update session interaction time
    await this.sessionService.updateLastInteraction(tenantId, customerPhone);

    // 3. Media Handling (Rule #2.C)
    if (messageType === 'image') {
      return this.escalateToHuman(tenantId, customerPhone, "User sent an image.", 30);
    }

    if (messageType === 'location') {
      const loc = message.location;
      // We could store loc.latitude/loc.longitude in session status
      const text = "📍 *Location Received*\nWould you like us to deliver your order to this location?";
      const buttons = [
        { id: 'CONFIRM_LOCATION', title: 'Yes, Deliver Here ✅' },
        { id: 'menu', title: 'Change Address 🏠' },
        { id: 'HUMAN', title: 'Talk to Staff 🧑‍🍳' }
      ];
      return this.sendInteractiveButtons(tenantId, customerPhone, text, buttons);
    }

    if (['audio', 'video', 'document', 'sticker'].includes(messageType)) {
      const text = "I can't process this type of message yet 😅 Please type your order or use the menu below.";
      const buttons = [
        { id: 'menu', title: 'Browse Menu 🍱' },
        { id: 'HUMAN', title: 'Talk to Staff 🧑‍🍳' }
      ];
      return this.sendInteractiveButtons(tenantId, customerPhone, text, buttons);
    }

    if (!rawText) return;
    this.logger.log(`Message from ${customerPhone}: ${rawText}`);

    // Business Hours Check
    const isOpen = await this.isBusinessOpen(tenantId);
    if (!isOpen) {
      const closedMsg = await this.getTemplate(tenantId, 'BUSINESS_CLOSED',
        "We are currently closed. Please visit us during our working hours!");
      await this.logMessage(tenantId, customerPhone, 'USER', rawText);
      await this.sendTextMessage(tenantId, customerPhone, closedMsg);
      return;
    }

    await this.logMessage(tenantId, customerPhone, 'USER', rawText);

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

    // Wrap all responses to ensure no dead-ends
    const finalResponse = await this.wrapResponse(tenantId, customerPhone, commandResponse);

    if (typeof finalResponse === 'string') {
      this.logger.debug(`Sending text response: ${finalResponse}`);
      await this.sendTextMessage(tenantId, customerPhone, finalResponse);
    } else if (finalResponse.type === 'list') {
      const cr = finalResponse as any;
      await this.sendListMessage(
        tenantId,
        customerPhone,
        cr.body || "Please select:",
        cr.buttonLabel || "View Options",
        cr.sections || [],
        cr.header,
        cr.footer
      );
    } else if (finalResponse.type === 'buttons') {
      const cr = finalResponse as any;
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

  async escalateToHuman(tenantId: string, phone: string, reason: string, pauseMinutes = 60) {
    await this.sessionService.pauseBot(tenantId, phone, pauseMinutes);

    // Persist alert to DB
    await this.prisma.staffAlert.create({
      data: { tenantId, customerPhone: phone, reason }
    });

    // Notify Dashboard via WebSocket
    this.eventsGateway.emitStaffNotification(tenantId, phone, reason);

    const text = `Got it. Our team will contact you on this number within ${pauseMinutes} minutes 👍\n\nI'll stay quiet until then, or you can click "Resume Bot" to talk to me again.`;
    const buttons = [
      { id: 'VIEW_CART', title: 'View Cart 🛒' },
      { id: 'menu', title: 'Main Menu 🍱' },
      { id: 'RESUME_BOT', title: 'Resume Bot 🤖' }
    ];

    return this.sendInteractiveButtons(tenantId, phone, text, buttons);
  }

  /**
   * Universal response wrapper to ensure No Dead-Ends (Rule #1).
   * Appends [Browse Menu] [View Cart] [Talk to Staff] if space permits.
   */
  private async wrapResponse(tenantId: string, phone: string, response: any): Promise<any> {
    if (typeof response === 'string') {
      return {
        type: 'buttons',
        text: response,
        buttons: [
          { id: 'menu', title: 'Browse Menu 🍱' },
          { id: 'VIEW_CART', title: 'View Cart 🛒' },
          { id: 'HUMAN', title: 'Talk to Staff 🧑‍🍳' }
        ]
      };
    }

    if (response.type === 'buttons') {
      const buttons = response.buttons || [];
      if (buttons.length < 3) {
        if (!buttons.find((b: any) => b.id === 'menu')) buttons.push({ id: 'menu', title: 'Main Menu 🍱' });
      }
      if (buttons.length < 3) {
        if (!buttons.find((b: any) => b.id === 'VIEW_CART')) buttons.push({ id: 'VIEW_CART', title: 'View Cart 🛒' });
      }
      if (buttons.length < 3) {
        if (!buttons.find((b: any) => b.id === 'HUMAN')) buttons.push({ id: 'HUMAN', title: 'Talk to Staff 🧑‍🍳' });
      }
      response.buttons = buttons.slice(0, 3);
    }

    return response;
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
    let response: any = null;

    // 1. A. Direct Action Button IDs (Rule #2.A)
    if (lowerText.startsWith('order_')) {
      const productId = rawText.slice(6);
      const cartStatus = await this.orderService.addToCart(tenantId, customerPhone, productId);
      response = await this.buildAddedToCartMessage(cartStatus);
    }
    else if (lowerText === 'view_cart' || lowerText === 'cart' || lowerText === 'basket') {
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      if (!cart || cart.items.length === 0) {
        response = {
          type: 'buttons',
          text: "Your cart is empty. Send 'menu' to see our delicious items!",
          buttons: [{ id: 'menu', title: 'Browse Menu 🍱' }]
        };
      } else {
        response = await this.buildCartListMessage(cart);
      }
    }

    else if (lowerText.startsWith('edit_')) {
      const productId = rawText.slice(5);
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      const item = (cart?.items || []).find(i => i.productId === productId);
      response = item ? await this.buildEditItemMessage(item) : "Item not found in cart.";
    }
    else if (lowerText.startsWith('qty_inc_')) {
      const productId = rawText.slice(8);
      await this.orderService.incrementItemQty(tenantId, customerPhone, productId);
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      const item = (cart?.items || []).find(i => i.productId === productId);
      response = item ? await this.buildEditItemMessage(item) : await this.buildCartListMessage(cart);
    }
    else if (lowerText.startsWith('qty_dec_')) {
      const productId = rawText.slice(8);
      await this.orderService.decrementItemQty(tenantId, customerPhone, productId);
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      const item = (cart?.items || []).find(i => i.productId === productId);
      response = item ? await this.buildEditItemMessage(item) : await this.buildCartListMessage(cart);
    }
    else if (lowerText.startsWith('remove_')) {
      const productId = rawText.slice(7);
      await this.orderService.removeItemFromCart(tenantId, customerPhone, productId);
      const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
      response = (!cart || cart.items.length === 0) ? "Item removed. Your cart is now empty." : await this.buildCartListMessage(cart);
    }
    else if (['empty_cart', 'clear_cart', 'cancel', 'clear', 'empty'].includes(lowerText)) {
      await this.orderService.clearCart(tenantId, customerPhone);
      response = "🗑️ Your cart has been cleared. Send 'menu' to start again!";
    }
    else if (['human', 'staff', 'agent', 'call', 'talk', 'speak', 'help', 'HUMAN'].includes(lowerText)) {
      return this.escalateToHuman(tenantId, customerPhone, "User requested human help.");
    }
    else if (lowerText === 'sticker' || lowerText === 'stickers') {
      const stickers = await this.prisma.sticker.findMany();
      if (stickers.length > 0) {
        const randomSticker = stickers[Math.floor(Math.random() * stickers.length)];
        try {
          await this.stickerService.sendSticker(
            { phoneNumber: customerPhone, stickerId: randomSticker.id, consent: true },
            tenantId
          );
        } catch (e: any) {
          this.logger.error('Failed to auto-send sticker', e);
        }
        return; // Early return prevents text fallback
      } else {
        response = "Sorry, we don't have any fun stickers right now! 😅";
      }
    }
    else if (['menu', 'start', 'hi', 'hello', 'MAIN_MENU'].includes(lowerText)) {
      response = await this.showMainMenu(tenantId, customerPhone);
    }
    else if (lowerText.startsWith('cat_')) {
      const catName = rawText.slice(4);
      response = await this.showCategoryProducts(tenantId, catName);
    }
    else if (lowerText.startsWith('prod_')) {
      const productId = rawText.slice(5);
      const product = await this.prisma.product.findUnique({ where: { id: productId } });
      response = product ? await this.showProductDetails(tenantId, product) : "Product not found.";
    }
    else if (lowerText === 'checkout') {
      response = await this.handleCheckout(tenantId, customerPhone);
    }
    else if (lowerText === 'status') {
      response = await this.handleStatusCheck(tenantId, customerPhone);
    }
    else if (lowerText === 'call_restaurant') {
      response = await this.handleCallRestaurant(tenantId, customerPhone);
    }
    else if (lowerText.startsWith('reviews ')) {
      response = await this.handleReviewSummary(tenantId, rawText.slice(8).trim());
    }

    // 2. Fallback Logic: Try Product Search before giving up (Rule #2B)
    if (!response) {
      response = await this.handleProductSearch(tenantId, customerPhone, rawText);
      if (response === null) return null;
    }

    // 3. Last Resort Fallback Logic (Rule #2.D)
    if (!response || (typeof response === 'string' && response.includes('not sure'))) {
      const count = await this.sessionService.incrementFallback(tenantId, customerPhone);
      if (count >= 2) {
        return this.escalateToHuman(tenantId, customerPhone, `Bot failed to understand user after 2 attempts. Last message: "${rawText}"`);
      }

      const fallback = response || "I didn't quite get that 😅 Here’s what you can do:";
      return this.handleDelayedFallback(tenantId, customerPhone, rawText, fallback);
    } else {
      await this.sessionService.resetFallbacks(tenantId, customerPhone);
    }

    return response;
  }

  /**
   * Delayed fallback logic for unusual messages.
   * Ensures staff has a chance to reply before the bot sends a default "I don't know" message.
   */
  private async handleDelayedFallback(tenantId: string, customerPhone: string, rawText: string, fallbackResponse: any) {
    const timestamp = new Date();
    const reason = `Unusual message from ${customerPhone}: "${rawText}"`;

    // 1. Deduplication: only alert if no alert was created for this customer in the last 2 minutes
    const twoMinutesAgo = new Date(timestamp.getTime() - 2 * 60 * 1000);
    const recentAlert = await this.prisma.staffAlert.findFirst({
      where: {
        tenantId,
        customerPhone,
        createdAt: { gte: twoMinutesAgo }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!recentAlert) {
      await this.prisma.staffAlert.create({
        data: { tenantId, customerPhone, reason }
      });
      this.eventsGateway.emitStaffNotification(tenantId, customerPhone, reason);
    } else {
      this.logger.debug(`Suppressing duplicate alert for ${customerPhone} — one already exists within 2 minutes.`);
    }

    // 2. Schedule Bot Response (60s delay)
    setTimeout(async () => {
      try {
        // Check if bot is still enabled
        const currentTenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
        if (!currentTenant?.isBotEnabled) return;

        // Check for manual staff messages sent AFTER the trigger message
        const staffReply = await this.prisma.chatMessage.findFirst({
          where: {
            tenantId,
            customerPhone,
            sender: 'STAFF',
            createdAt: { gte: timestamp }
          }
        });

        // If no staff reply within the minute, let the bot send the fallback
        if (!staffReply) {
          if (typeof fallbackResponse === 'string') {
            await this.sendTextMessage(tenantId, customerPhone, fallbackResponse);
          } else if (fallbackResponse.type === 'buttons') {
            await this.sendInteractiveButtons(tenantId, customerPhone, fallbackResponse.text, fallbackResponse.buttons);
          } else if (fallbackResponse.type === 'list') {
            await this.sendListMessage(tenantId, customerPhone, fallbackResponse.body, fallbackResponse.buttonLabel, fallbackResponse.sections);
          }
        }
      } catch (err: any) {
        this.logger.error(`Error in delayed fallback: ${err.message}`);
      }
    }, 60000);

    return null; // Suppress immediate bot response
  }

  // --- Helper methods for modular handleCommand ---
  private async showMainMenu(tenantId: string, customerPhone: string) {
    const products = (await this.productService.listAvailable(tenantId)) as any[];
    if (!products.length) {
      return this.getTemplate(tenantId, 'MENU_EMPTY', 'No products are available right now.');
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    let categories: string[] = (tenant?.categories as string[]) || [];

    // Fallback: If tenant has no categories or they don't match products, infer from products
    if (!categories.length || categories.every(cat => products.filter(p => p.category === cat).length === 0)) {
      categories = [...new Set(products.map(p => p.category || 'General'))] as string[];
    }

    // 1. Unified Cart Summary (Rule #9.2)
    const cart = await this.orderService.getDetailedCart(tenantId, customerPhone);
    const cartRows = [];
    if (cart && cart.items.length > 0) {
      cartRows.push(
        { id: 'VIEW_CART', title: '🛒 View Cart Items'.slice(0, 24), description: `${cart.count} items | ${formatInr(cart.total)}`.slice(0, 72) },
        { id: 'CHECKOUT', title: '💳 Proceed to Checkout'.slice(0, 24), description: 'Finalize your order'.slice(0, 72) }
      );
    }

    // 2. Category / Product Listing
    const availableRows = 10 - cartRows.length;
    const entries = categories
      .map(cat => ({ id: `CAT_${cat}`, title: cat.slice(0, 24), description: `Explore ${products.filter(p => p.category === cat).length} items`.slice(0, 72) }))
      .filter(item => !item.description.includes('0 items')) // Only show non-empty cats
      .slice(0, availableRows);

    const finalSections = [];
    if (cartRows.length > 0) finalSections.push({ title: 'Current Cart', rows: cartRows });
    if (entries.length > 0) finalSections.push({ title: 'Categories', rows: entries });

    const baseUrl = this.configService.get<string>('APP_BASE_URL') ?? 'http://localhost:4000';
    const menuUrl = `${baseUrl}/public/orders/menu/${tenantId}`;

    return {
      type: 'list',
      header: '🍱 *Menu Explorer*',
      body: `Select a category or checkout below.\n\n📖 *View Full Digital Menu*: \n${menuUrl}`,
      buttonLabel: 'Explore Menu',
      sections: finalSections
    };
  }

  private async showCategoryProducts(tenantId: string, catName: string) {
    const products = await this.productService.listAvailable(tenantId);
    const filtered = (products as any[]).filter(p => (catName === 'General' ? !p.category : p.category === catName));

    const rows = filtered.slice(0, 10).map(p => ({
      id: `PROD_${p.id}`,
      title: p.name.slice(0, 24),
      description: `${formatInr(Number(p.price))} - ${p.description || ''}`.slice(0, 72)
    }));

    return {
      type: 'list',
      header: `📂 *${catName}*`,
      body: `Items in ${catName}:`,
      buttonLabel: 'Select Item',
      sections: [{ title: catName.slice(0, 24), rows }]
    };
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
          return applies && val !== undefined && val !== null && val !== '';
        })
        .map((f: any) => {
          const val = (product.attributes as any)[f.name];
          let displayVal = val;
          if (f.type === 'number' && f.options && Array.isArray(f.options)) {
            displayVal = f.options[val] || val;
          }
          const iconPrefix = f.icon ? f.icon + ' ' : '';
          return `${iconPrefix}${f.label || f.name}: ${displayVal}`;
        });

      if (attributeLines.length > 0) {
        responseText += `\nAttributes:\n${attributeLines.join('\n')}`;
      }
    }

    return {
      type: 'buttons',
      text: responseText,
      buttons: [
        { id: `ORDER_${product.id}`, title: 'Add to Cart ➕' },
        { id: 'VIEW_CART', title: 'View Cart 🛒' },
        { id: 'menu', title: 'Main Menu  Bento' }
      ].map((b: { id: string, title: string }) => ({ ...b, title: b.title.slice(0, 20) }))
    };
  }

  private async handleCheckout(tenantId: string, customerPhone: string) {
    const order = await this.orderService.finalizeOrder(tenantId, customerPhone);
    const baseUrl = this.configService.get<string>('APP_BASE_URL') ?? 'http://localhost:4000';
    const invoiceUrl = `${baseUrl}/public/orders/invoice/${order.id}`;

    const prompt = await this.getTemplate(tenantId, 'ORDER_PAYMENT_PROMPT',
      [
        `Great! Your order #${order.id.slice(-6).toUpperCase()} is received.`,
        `Total: ${formatInr(Number(order.totalAmount))}`,
        `🧾 *Invoice*: ${invoiceUrl}`,
        '',
        'How would you like to pay?'
      ].join('\n'));

    return {
      type: 'buttons',
      text: prompt,
      buttons: [
        { id: '1', title: 'Pay Online 💳' },
        { id: '2', title: 'COD 💵' }
      ]
    };
  }

  private async handleStatusCheck(tenantId: string, customerPhone: string) {
    const order = await this.orderService.getLatestOrderForCustomer(tenantId, customerPhone);
    if (!order) return "You don't have any orders yet!";

    const baseUrl = this.configService.get<string>('APP_BASE_URL') ?? 'http://localhost:4000';
    const invoiceUrl = `${baseUrl}/public/orders/invoice/${order.id}`;

    return this.getTemplate(tenantId, 'ORDER_STATUS',
      [`Latest order: {{id}}`, `Status: {{status}}`, `Total: {{total}}`, `🧾 Invoice: ${invoiceUrl}`].join('\n'),
      { id: order.id, status: order.status, total: formatInr(Number(order.totalAmount)) });
  }

  private async handleReviewSummary(tenantId: string, itemName: string) {
    const summary = await this.reviewService.getReviewSummaryByItemName(tenantId, itemName);
    if (!summary.reviewCount) return `No reviews yet for ${summary.product.name}.`;

    return [
      `*${summary.product.name}*`,
      `Avg Rating: ${summary.averageRating.toFixed(1)}/5`,
      'Latest reviews:',
      ...summary.latestReviews.map((r: any) => `${r.rating}/5 - ${r.comment}`),
    ].join('\n');
  }

  private async buildBulkOrderResponse(result: any) {
    const { cart, results, errors } = result;
    let response = `🛒 *Bulk Order Processed!*\n\n`;
    if (results.length > 0) response += `*Added to Cart:*\n${results.map((r: any) => `• ${r}`).join('\n')}\n\n`;
    if (errors.length > 0) response += `⚠️ *Not Found*:\n${errors.map((e: any) => `• ${e}`).join('\n')}\n\n`;

    const totalItems = (cart.orderItems as any[]).reduce((acc: number, item: any) => acc + item.quantity, 0);
    response += `*Total Items:* ${totalItems}\n*Total Amount:* ${formatInr(Number(cart.totalAmount))}`;

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

  private parseSearchInput(text: string): { quantity: number; itemName: string } {
    const wordNumbers: any = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

    // Step 1: Check for leading quantity word/number  ("2 pizza", "two pizza")
    const withQty = text.trim().match(/^(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/i);
    if (withQty) {
      const qtyStr = withQty[1].toLowerCase();
      const quantity = wordNumbers[qtyStr] || parseInt(qtyStr, 10) || 1;
      const rawItem = withQty[2].trim();
      // Still run keyword extraction on the item part
      const itemName = extractFoodName(rawItem);
      return { quantity, itemName };
    }

    // Step 2: Check for trailing quantity ("pizza 2")
    const trailingQty = text.trim().match(/^(.+?)\s+(\d+)$/i);
    if (trailingQty) {
      const itemName = extractFoodName(trailingQty[1].trim());
      return { quantity: parseInt(trailingQty[2], 10), itemName };
    }

    // Step 3: Just a food phrase ("biryani hai kya", "pizza please")
    const itemName = extractFoodName(text.trim());
    return { quantity: 1, itemName };
  }

  private async handleProductSearch(tenantId: string, customerPhone: string, rawText: string) {
    const { quantity, itemName } = this.parseSearchInput(rawText);

    if (!itemName || itemName.length < 2) {
      const fallback = "I'm not sure what you're looking for 😅 Send 'menu' to browse everything!";
      return this.handleDelayedFallback(tenantId, customerPhone, rawText, fallback);
    }

    const results = await this.orderService.searchProducts(tenantId, itemName);

    // EXACT MATCH 1 RESULT (Rule 2B Step 3.A)
    // High similarity (> 0.8) or exact name match
    if (results.length === 1 || (results.length > 0 && results[0].similarity > 0.8)) {
      const product = results[0];
      await this.orderService.addToCart(tenantId, customerPhone, product.id, quantity);

      return {
        type: 'buttons',
        text: `✅ Added: ${quantity}x ${product.name} - ${formatInr(Number(product.price) * quantity)}`,
        buttons: [
          { id: 'menu', title: '➕ Add More' },
          { id: 'VIEW_CART', title: '🛒 View Cart' },
          { id: 'checkout', title: 'Checkout 💳' }
        ]
      };
    }

    // MULTIPLE MATCHES 2-3 RESULTS (Rule 2B Step 3.B)
    if (results.length >= 2) {
      const sections = [{
        title: `Search: "${itemName}"`,
        rows: results.slice(0, 8).map(p => ({
          id: `PROD_${p.id}`,
          title: p.name.slice(0, 24),
          description: formatInr(Number(p.price))
        }))
      }];

      // Reserved rows for Call/Staff (Rule 2C)
      sections[0].rows.push({ id: 'CALL_RESTAURANT', title: '📞 Call Restaurant', description: 'Talk to us directly' });
      sections[0].rows.push({ id: 'HUMAN', title: '🙋 Talk to Staff', description: 'Ask us anything' });

      return {
        type: 'list',
        header: 'Matches Found',
        body: `I found ${results.length} items for "${itemName}". Which one did you mean?`,
        footer: 'Select an item to view details',
        buttonLabel: 'View Matches',
        sections
      };
    }

    // Log the clean extracted name (not the raw conversational text)
    await this.prisma.unknownIntentLog.create({
      data: {
        tenantId,
        customerPhone,
        query: itemName,   // clean name e.g. "biryani" not "biryani hai kya"
        tag: 'PRODUCT_NOT_FOUND'
      }
    });

    const displayName = itemName
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const fallback = {
      type: 'buttons',
      text: `Sorry, we don't have *${displayName}* on our menu 😅\n\nCan I help you with something else?`,
      buttons: [
        { id: 'CALL_RESTAURANT', title: '📞 Call Restaurant' },
        { id: 'menu', title: '🍱 Browse Menu' },
        { id: 'HUMAN', title: '🧑‍🍳 Talk to Staff' }
      ]
    };

    return this.handleDelayedFallback(tenantId, customerPhone, rawText, fallback);
  }

  private async handleCallRestaurant(tenantId: string, customerPhone: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant?.phone) {
      return "I'm sorry, we don't have a contact phone listed yet. Please try 'Talk to Staff' instead.";
    }

    const reason = "Customer tapped 'Call Restaurant' - ready to call: " + tenant.phone;

    // Persist alert to DB
    await this.prisma.staffAlert.create({
      data: { tenantId, customerPhone, reason }
    });

    // Notify Dashboard via WebSocket
    this.eventsGateway.emitStaffNotification(tenantId, customerPhone, reason);

    return `Tap to call us directly: tel:${tenant.phone}\n\nWhatsApp will open your dialer automatically!`;
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

    const lowerText = rawText.trim().toLowerCase();
    const highlights = ['hi', 'hello', 'start', 'menu', 'cart', 'view', 'help', 'status'];
    const isCommand = highlights.some(h => lowerText.includes(h));

    if (isCommand) {
      // If user sends a command/greeting, abort ALL pending review conversations for this user
      await this.prisma.order.updateMany({
        where: {
          tenantId,
          customerPhone,
          reviewConversation: {
            in: [ReviewConversationState.WAITING_FOR_RATING, ReviewConversationState.WAITING_FOR_COMMENT],
          },
        },
        data: { reviewConversation: ReviewConversationState.NONE }
      });
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
      await this.logMessage(tenantId, to, 'BOT', bodyText);
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
      await this.logMessage(tenantId, to, 'BOT', bodyText);
    } catch (error: any) {
      this.logger.error(`Failed to send list message: ${JSON.stringify(error.response?.data || error.message)}`);
    }
  }

  async sendTextMessage(tenantId: string, to: string, text: string, sender: 'BOT' | 'STAFF' = 'BOT') {
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
      await this.logMessage(tenantId, to, sender, text);
    } catch (error: any) {
      this.logger.error(`Failed to send WhatsApp message to ${to}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
      throw new HttpException('Failed to send WhatsApp message', HttpStatus.BAD_GATEWAY);
    }
  }

  private async logMessage(tenantId: string, customerPhone: string, sender: 'USER' | 'BOT' | 'STAFF', content: string) {
    try {
      await this.prisma.chatMessage.create({
        data: {
          tenantId,
          customerPhone,
          sender,
          content: content.slice(0, 5000) // Safety truncation
        }
      });
      // Emit real-time signal
      this.eventsGateway.emitMessage(tenantId, customerPhone, sender, content);
    } catch (error: any) {
      this.logger.error(`Failed to log chat message: ${error.message}`);
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
