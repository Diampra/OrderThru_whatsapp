import { HttpException, HttpStatus, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReviewConversationState } from '@prisma/client';
import axios from 'axios';
import type { Response } from 'express';
import { formatInr } from '../../common/utils/currency';
import { MenuService } from '../menu/menu.service';
import { OrderService } from '../order/order.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewService } from '../review/review.service';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly menuService: MenuService,
    private readonly reviewService: ReviewService,
    @Inject(forwardRef(() => OrderService)) private readonly orderService: OrderService,
  ) {}

  verifyWebhook(mode: string, verifyToken: string, challenge: string, response: Response) {
    const expectedToken = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (mode === 'subscribe' && verifyToken === expectedToken) {
      return response.status(200).send(challenge);
    }

    return response.sendStatus(403);
  }

  async handleIncomingWebhook(payload: any) {
    const message = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message?.text?.body || !message?.from) {
      return;
    }

    const customerPhone = message.from;
    const rawText = message.text.body.trim();

    const reviewResponse = await this.tryHandleReviewConversation(customerPhone, rawText);
    if (reviewResponse) {
      await this.sendTextMessage(customerPhone, reviewResponse);
      return;
    }

    const responseText = await this.handleCommand(customerPhone, rawText);
    await this.sendTextMessage(customerPhone, responseText);
  }

  async handleCommand(customerPhone: string, rawText: string) {
    const lowerText = rawText.trim().toLowerCase();

    if (lowerText === 'help') {
      return ['Commands:', 'menu', 'order <item>', 'status', 'reviews <item>', 'help'].join('\n');
    }

    if (lowerText === 'menu') {
      const items = await this.menuService.listAvailable();
      if (!items.length) {
        return 'No menu items are available right now.';
      }

      return items
        .map(
          (item: { name: string; price: unknown; description: string }) =>
            `${item.name} - ${formatInr(Number(item.price))}\n${item.description}`,
        )
        .join('\n\n');
    }

    if (lowerText.startsWith('order ')) {
      const itemName = rawText.slice(6).trim();
      const order = await this.orderService.createOrderFromItemName(customerPhone, itemName);
      return this.orderService.formatOrderConfirmation({
        ...order,
        totalAmount: Number(order.totalAmount),
      });
    }

    if (lowerText === 'status') {
      const order = await this.orderService.getLatestOrderForCustomer(customerPhone);
      return [
        `Latest order: ${order.id}`,
        `Status: ${order.status}`,
        `Total: ${formatInr(Number(order.totalAmount))}`,
      ].join('\n');
    }

    if (lowerText.startsWith('reviews ')) {
      const itemName = rawText.slice(8).trim();
      const summary = await this.reviewService.getReviewSummaryByItemName(itemName);
      if (!summary.reviewCount) {
        return `No reviews yet for ${summary.item.name}.`;
      }

      const reviewLines = summary.latestReviews.map((review: { rating: number; comment: string }) => {
        return `${review.rating}/5 - ${review.comment}`;
      });

      return [
        `${summary.item.name}`,
        `Average rating: ${summary.averageRating.toFixed(1)}/5`,
        'Latest reviews:',
        ...reviewLines,
      ].join('\n');
    }

    return 'Unknown command. Send "help" to see supported commands.';
  }

  async tryHandleReviewConversation(customerPhone: string, rawText: string) {
    const order = await this.prisma.order.findFirst({
      where: {
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

    await this.reviewService.createReviewsForOrder(order.id, order.pendingReviewRating, rawText);
    return 'Thanks for your feedback.';
  }

  async sendTextMessage(to: string, text: string) {
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken = this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');
    const apiVersion = this.configService.get<string>('WHATSAPP_API_VERSION') ?? 'v20.0';

    if (!phoneNumberId || !accessToken) {
      this.logger.warn(`WhatsApp credentials missing. Message to ${to}: ${text}`);
      return;
    }

    try {
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
    } catch (error) {
      this.logger.error('Failed to send WhatsApp message', error);
      throw new HttpException('Failed to send WhatsApp message', HttpStatus.BAD_GATEWAY);
    }
  }
}
