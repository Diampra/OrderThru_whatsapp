import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { DashboardService } from './dashboard.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Roles(Role.TENANT_ADMIN)
  @Get('summary')
  getSummary(@Req() req: any) {
    return this.dashboardService.getSummary(req.user.tenantId);
  }

  @Roles(Role.TENANT_ADMIN)
  @Get('alerts')
  getAlerts(@Req() req: any) {
    return this.dashboardService.getAlerts(req.user.tenantId);
  }

  @Roles(Role.TENANT_ADMIN)
  @Patch('alerts/:id/dismiss')
  dismissAlert(@Req() req: any, @Param('id') id: string) {
    return this.dashboardService.dismissAlert(req.user.tenantId, id);
  }

  @Roles(Role.TENANT_ADMIN)
  @Post('reply')
  sendReply(@Req() req: any, @Body() body: { customerPhone: string; message: string }) {
    return this.dashboardService.sendReply(req.user.tenantId, body.customerPhone, body.message);
  }

  @Roles(Role.TENANT_ADMIN)
  @Post('manual-order')
  createManualOrder(@Req() req: any, @Body() body: { customerPhone: string; items: Array<{ productId: string; quantity: number }> }) {
    return this.dashboardService.createManualOrder(req.user.tenantId, body.customerPhone, body.items);
  }
}
