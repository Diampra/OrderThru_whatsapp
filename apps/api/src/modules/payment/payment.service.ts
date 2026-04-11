import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Razorpay from 'razorpay';

interface PaymentLinkInput {
  orderId: string;
  amount: number;
  customerPhone: string;
  description: string;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly razorpay: Razorpay | null;

  constructor(private readonly configService: ConfigService) {
    const keyId = this.configService.get<string>('RAZORPAY_KEY_ID');
    const keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET');

    this.razorpay =
      keyId && keySecret
        ? new Razorpay({
            key_id: keyId,
            key_secret: keySecret,
          })
        : null;
  }

  async createPaymentLink(input: PaymentLinkInput) {
    if (!this.razorpay) {
      this.logger.warn('Razorpay keys missing, using fallback payment link.');
      return {
        id: `mock_${input.orderId}`,
        short_url: `${this.configService.get<string>('APP_BASE_URL') ?? 'http://localhost:4000'}/payments/mock/${input.orderId}`,
      };
    }

    return this.razorpay.paymentLink.create({
      amount: Math.round(input.amount * 100),
      currency: 'INR',
      description: input.description,
      customer: {
        contact: input.customerPhone,
      },
      notify: {
        email: false,
        sms: false,
      },
      reminder_enable: true,
      reference_id: input.orderId,
    });
  }
}
