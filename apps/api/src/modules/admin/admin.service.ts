import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        whatsappVerifyToken: true,
        whatsappPhoneNumberId: true,
        whatsappAccessToken: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  async updateSettings(
    tenantId: string,
    data: {
      name?: string;
      whatsappVerifyToken?: string;
      whatsappPhoneNumberId?: string;
      whatsappAccessToken?: string;
    },
  ) {
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data,
      select: {
        id: true,
        name: true,
        whatsappVerifyToken: true,
        whatsappPhoneNumberId: true,
        whatsappAccessToken: true,
      },
    });
  }
}
