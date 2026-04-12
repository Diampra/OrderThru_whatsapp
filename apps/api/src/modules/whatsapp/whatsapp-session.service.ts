import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WhatsAppSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async getSession(tenantId: string, customerPhone: string) {
    let session = await this.prisma.whatsAppSession.findUnique({
      where: {
        tenantId_customerPhone: {
          tenantId,
          customerPhone,
        },
      },
    });

    if (!session) {
      session = await this.prisma.whatsAppSession.create({
        data: {
          tenantId,
          customerPhone,
        },
      });
    }

    return session;
  }

  async isPaused(tenantId: string, customerPhone: string): Promise<boolean> {
    const session = await this.getSession(tenantId, customerPhone);
    if (!session.botPausedUntil) return false;
    return new Date() < new Date(session.botPausedUntil);
  }

  async pauseBot(tenantId: string, customerPhone: string, minutes: number) {
    const pausedUntil = new Date(Date.now() + minutes * 60 * 1000);
    await this.prisma.whatsAppSession.update({
      where: {
        tenantId_customerPhone: {
          tenantId,
          customerPhone,
        },
      },
      data: {
        botPausedUntil: pausedUntil,
        consecutiveFallbacks: 0, // Reset fallbacks on manual handoff
      },
    });
  }

  async resumeBot(tenantId: string, customerPhone: string) {
    await this.prisma.whatsAppSession.update({
      where: {
        tenantId_customerPhone: {
          tenantId,
          customerPhone,
        },
      },
      data: {
        botPausedUntil: null,
        consecutiveFallbacks: 0,
      },
    });
  }

  async incrementFallback(tenantId: string, customerPhone: string): Promise<number> {
    const session = await this.prisma.whatsAppSession.update({
      where: {
        tenantId_customerPhone: {
          tenantId,
          customerPhone,
        },
      },
      data: {
        consecutiveFallbacks: { increment: 1 },
      },
    });
    return session.consecutiveFallbacks;
  }

  async resetFallbacks(tenantId: string, customerPhone: string) {
    await this.prisma.whatsAppSession.update({
      where: {
        tenantId_customerPhone: {
          tenantId,
          customerPhone,
        },
      },
      data: {
        consecutiveFallbacks: 0,
      },
    });
  }

  async updateLastInteraction(tenantId: string, customerPhone: string) {
    await this.prisma.whatsAppSession.update({
      where: {
        tenantId_customerPhone: {
          tenantId,
          customerPhone,
        },
      },
      data: {
        lastInteractionAt: new Date(),
      },
    });
  }
}
