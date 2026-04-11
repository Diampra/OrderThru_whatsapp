import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderService } from './order.service';

@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  listOrders() {
    return this.orderService.listOrders();
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: UpdateOrderStatusDto) {
    return this.orderService.updateStatus(id, body.status);
  }
}
