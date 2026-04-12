import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AdminService } from './admin.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Roles(Role.TENANT_ADMIN)
  @Get('settings')
  getSettings(@Req() req: any) {
    return this.adminService.getSettings(req.user.tenantId);
  }

  @Roles(Role.TENANT_ADMIN)
  @Patch('settings')
  updateSettings(
    @Req() req: any,
    @Body()
    body: {
      name?: string;
      whatsappVerifyToken?: string;
      whatsappPhoneNumberId?: string;
      whatsappAccessToken?: string;
    },
  ) {
    return this.adminService.updateSettings(req.user.tenantId, body);
  }
}
