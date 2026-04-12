import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductService } from './product.service';

@Controller('product')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get('tenant/:tenantId')
  listAvailable(@Param('tenantId') tenantId: string) {
    return this.productService.listAvailable(tenantId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @Get('admin/all')
  listAll(@Req() req: any) {
    return this.productService.listAll(req.user.tenantId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @Post()
  create(@Req() req: any, @Body() body: CreateProductDto) {
    return this.productService.create(req.user.tenantId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateProductDto) {
    return this.productService.update(req.user.tenantId, id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.productService.remove(req.user.tenantId, id);
  }
}
