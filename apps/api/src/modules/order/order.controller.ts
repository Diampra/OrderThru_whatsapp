import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderService } from './order.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Roles(Role.TENANT_ADMIN)
  @Get()
  listOrders(@Req() req: any) {
    return this.orderService.listOrders(req.user.tenantId);
  }

  @Roles(Role.TENANT_ADMIN)
  @Patch(':id/status')
  updateStatus(@Req() req: any, @Param('id') id: string, @Body() body: UpdateOrderStatusDto) {
    return this.orderService.updateStatus(req.user.tenantId, id, body.status);
  }
}
