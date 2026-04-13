import { Body, Controller, Get, Param, Patch, Query, Req, Res, UseGuards, Header } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderService } from './order.service';
import { InvoiceService } from './invoice.service';

@Controller()
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly invoiceService: InvoiceService
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @Get('orders')
  listOrders(
    @Req() req: any,
    @Query('status') status?: OrderStatus,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('phone') phone?: string,
  ) {
    return this.orderService.listOrders(req.user.tenantId, { status, startDate, endDate, phone });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @Patch('orders/:id/status')
  updateStatus(@Req() req: any, @Param('id') id: string, @Body() body: UpdateOrderStatusDto) {
    return this.orderService.updateStatus(req.user.tenantId, id, body.status);
  }

  @Get('public/orders/invoice/:id')
  @Header('Content-Type', 'application/pdf')
  async downloadInvoice(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.invoiceService.generateInvoice(id);
    
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="invoice_${id.slice(-6).toUpperCase()}.pdf"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }

  @Get('public/orders/menu/:tenantId')
  @Header('Content-Type', 'application/pdf')
  async downloadMenu(@Param('tenantId') tenantId: string, @Res() res: Response) {
    const buffer = await this.invoiceService.generateMenuPdf(tenantId);
    
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="menu_${tenantId.slice(0, 6)}.pdf"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }
}
