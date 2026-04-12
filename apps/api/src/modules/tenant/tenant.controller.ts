import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { TenantService } from './tenant.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tenants')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Roles(Role.SUPER_ADMIN)
  @Get()
  findAll() {
    return this.tenantService.findAll();
  }

  @Roles(Role.TENANT_ADMIN)
  @Get('admin/me')
  findMe(@Req() req: any) {
    return this.tenantService.findOne(req.user.tenantId);
  }

  @Roles(Role.SUPER_ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tenantService.findOne(id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id/schema')
  updateSchema(@Param('id') id: string, @Body() schema: any) {
    return this.tenantService.updateSchema(id, schema);
  }

  @Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    if (req.user.role === Role.TENANT_ADMIN && req.user.tenantId !== id) {
      throw new ForbiddenException('You can only update your own tenant settings');
    }

    // If TENANT_ADMIN, restrict to safe fields
    if (req.user.role === Role.TENANT_ADMIN) {
      const { openTime, closeTime, timezone, messageTemplates, categories, isBotEnabled } = body;
      return this.tenantService.update(id, { openTime, closeTime, timezone, messageTemplates, categories, isBotEnabled });
    }

    return this.tenantService.update(id, body);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tenantService.remove(id);
  }
}
