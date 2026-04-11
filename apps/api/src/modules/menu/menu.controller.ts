import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { MenuService } from './menu.service';

@Controller('menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  listAvailable() {
    return this.menuService.listAvailable();
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/all')
  listAll() {
    return this.menuService.listAll();
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Body() body: CreateMenuItemDto) {
    return this.menuService.create(body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateMenuItemDto) {
    return this.menuService.update(id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.menuService.remove(id);
  }
}
