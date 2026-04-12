import { Product } from '@prisma/client';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  listAll(tenantId: string) {
    return this.prisma.product.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
  }

  listAvailable(tenantId: string) {
    return this.prisma.product.findMany({
      where: { tenantId, isAvailable: true },
      orderBy: { name: 'asc' },
    });
  }

  async getById(tenantId: string, id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product || product.tenantId !== tenantId) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async findByName(tenantId: string, name: string) {
    const products = await this.prisma.product.findMany({
      where: { tenantId, isAvailable: true },
    });
    const normalizedName = name.trim().toLowerCase();
    return products.find((p: Product) => p.name.trim().toLowerCase() === normalizedName) ?? null;
  }

  async create(tenantId: string, dto: CreateProductDto) {
    const cleanedAttributes = await this.validateAttributes(tenantId, dto.category, dto.attributes);
    return this.prisma.product.create({
      data: { 
        ...dto, 
        tenantId,
        attributes: cleanedAttributes
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateProductDto) {
    const existing = await this.getById(tenantId, id);
    let finalAttributes = dto.attributes;

    if (dto.attributes || dto.category) {
      const category = dto.category || existing.category;
      const attributes = dto.attributes || existing.attributes;
      finalAttributes = await this.validateAttributes(tenantId, category, attributes, { isUpdate: true });
    }

    return this.prisma.product.update({
      where: { id },
      data: {
        ...dto,
        attributes: finalAttributes
      },
    });
  }

  async validateAttributes(tenantId: string, productCategory: string, attributes: any, options: { isUpdate?: boolean } = {}) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || !tenant.productSchema) return attributes;

    const schema = tenant.productSchema as any[];
    const attrs = attributes || {};
    const cleaned: Record<string, any> = {};

    for (const field of schema) {
      // Filter by category: 
      // If field.appliesTo exists and is not empty, only validate if productCategory matches.
      const applies = !field.appliesTo || !Array.isArray(field.appliesTo) || field.appliesTo.length === 0 || field.appliesTo.includes(productCategory);
      
      if (!applies) {
        continue; 
      }

      const val = attrs[field.name];

      // 1. Check required (only on create OR if category changed)
      // Actually, if it's required and applies, it should be present.
      if (field.required && (val === undefined || val === null || val === '')) {
         // If update, only throw if it's actually in 'attributes' or if we want strict enforcement
         if (!options.isUpdate) throw new BadRequestException(`Field ${field.name} is required`);
      }

      // 2. Validate type if value exists
      if (val !== undefined && val !== null && val !== '') {
        cleaned[field.name] = val; // Keep only applied fields
        
        switch (field.type) {
          case 'number':
            if (typeof val !== 'number' && Number.isNaN(Number(val))) {
              throw new BadRequestException(`Field ${field.name} must be a number`);
            }
            cleaned[field.name] = Number(val);
            break;
          case 'boolean':
            if (typeof val !== 'boolean' && val !== 'true' && val !== 'false') {
              throw new BadRequestException(`Field ${field.name} must be a boolean`);
            }
            cleaned[field.name] = val === true || val === 'true';
            break;
          case 'select':
            if (field.options && !field.options.includes(val)) {
              throw new BadRequestException(`Invalid option for ${field.name}. Selection must be one of: ${field.options.join(', ')}`);
            }
            break;
          case 'string':
          case 'text':
            if (typeof val !== 'string') {
              throw new BadRequestException(`Field ${field.name} must be a string`);
            }
            break;
        }
      }
    }

    return cleaned;
  }

  async remove(tenantId: string, id: string) {
    await this.getById(tenantId, id);
    return this.prisma.product.delete({
      where: { id },
    });
  }
}
