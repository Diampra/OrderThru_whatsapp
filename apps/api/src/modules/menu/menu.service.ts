import { MenuItem } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';

@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService) {}

  listAll() {
    return this.prisma.menuItem.findMany({
      orderBy: { name: 'asc' },
    });
  }

  listAvailable() {
    return this.prisma.menuItem.findMany({
      where: { isAvailable: true },
      orderBy: { name: 'asc' },
    });
  }

  async getById(id: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id } });
    if (!item) {
      throw new NotFoundException('Menu item not found');
    }
    return item;
  }

  async findByName(name: string) {
    const items = await this.prisma.menuItem.findMany({
      where: { isAvailable: true },
    });
    const normalizedName = name.trim().toLowerCase();
    return items.find((item: MenuItem) => item.name.trim().toLowerCase() === normalizedName) ?? null;
  }

  create(dto: CreateMenuItemDto) {
    return this.prisma.menuItem.create({
      data: dto,
    });
  }

  async update(id: string, dto: UpdateMenuItemDto) {
    await this.getById(id);
    return this.prisma.menuItem.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string) {
    await this.getById(id);
    return this.prisma.menuItem.delete({
      where: { id },
    });
  }
}
