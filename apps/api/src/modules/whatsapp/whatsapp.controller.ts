import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WhatsAppService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsAppService: WhatsAppService) {}

  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() response: Response,
  ) {
    return this.whatsAppService.verifyWebhook(mode, verifyToken, challenge, response);
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Body() body: unknown) {
    await this.whatsAppService.handleIncomingWebhook(body);
    return { received: true };
  }
}
