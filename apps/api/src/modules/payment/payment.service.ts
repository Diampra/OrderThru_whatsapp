import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Razorpay from 'razorpay';
import { PrismaService } from '../prisma/prisma.service';

interface PaymentLinkInput {
  orderId: string;
  amount: number;
  customerPhone: string;
  description: string;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private async getRazorpayClient(tenantId: string): Promise<Razorpay | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { razorpayKeyId: true, razorpayKeySecret: true },
    });

    const keyId = tenant?.razorpayKeyId || this.configService.get<string>('RAZORPAY_KEY_ID');
    const keySecret = tenant?.razorpayKeySecret || this.configService.get<string>('RAZORPAY_KEY_SECRET');

    if (!keyId || !keySecret || keyId.startsWith('rzp_test_xxxx')) {
      return null;
    }

    return new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
  }

  async createPaymentLink(tenantId: string, input: PaymentLinkInput) {
    const razorpay = await this.getRazorpayClient(tenantId);

    if (!razorpay) {
      this.logger.warn(`Razorpay keys missing for tenant ${tenantId}, using fallback payment link.`);
      return {
        id: `mock_${input.orderId}`,
        short_url: `${this.configService.get<string>('APP_BASE_URL') ?? 'http://localhost:4000'}/payments/mock/${input.orderId}`,
      };
    }

    return razorpay.paymentLink.create({
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
