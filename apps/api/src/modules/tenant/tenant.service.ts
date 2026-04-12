import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ProductSchemaField {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  required?: boolean;
  options?: string[];
  displayInList?: boolean;
}

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly DEFAULT_SCHEMAS: Record<string, ProductSchemaField[]> = {
    RESTAURANT: [
      { name: 'isVeg', type: 'boolean', displayInList: true },
      { name: 'spiceLevel', type: 'select', options: ['Mild', 'Medium', 'Hot'], displayInList: true },
      { name: 'calories', type: 'number' },
    ],
    CLOTHING: [
      { name: 'size', type: 'select', options: ['S', 'M', 'L', 'XL'], required: true, displayInList: true },
      { name: 'material', type: 'text', displayInList: true },
      { name: 'color', type: 'text' },
    ],
    PACKED_FOOD: [
      { name: 'weight', type: 'number', required: true, displayInList: true },
      { name: 'expiryDate', type: 'text' },
      { name: 'ingredients', type: 'text' },
    ],
  };

  async findAll() {
    return this.prisma.tenant.findMany({
      include: {
        _count: {
          select: { products: true, admins: true },
        },
      },
    });
  }

  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        admins: {
          include: {
            profile: {
              include: {
                user: {
                  select: { email: true }
                }
              }
            }
          }
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  async update(id: string, data: any) {
    // If businessType is changing and productSchema is currently null/empty, apply default
    if (data.businessType && this.DEFAULT_SCHEMAS[data.businessType]) {
      const tenant = await this.findOne(id);
      if (!tenant.productSchema || (Array.isArray(tenant.productSchema) && tenant.productSchema.length === 0)) {
        data.productSchema = this.DEFAULT_SCHEMAS[data.businessType];
      }
    }

    if (data.productSchema) {
      this.validateProductSchema(data.productSchema);
    }

    if (data.categories && !Array.isArray(data.categories)) {
       throw new BadRequestException('Categories must be an array of strings');
    }

    return this.prisma.tenant.update({
      where: { id },
      data,
    });
  }

  async updateSchema(id: string, schema: any) {
    this.validateProductSchema(schema);
    return this.prisma.tenant.update({
      where: { id },
      data: { productSchema: schema },
    });
  }

  validateProductSchema(schema: any) {
    if (!Array.isArray(schema)) {
      throw new BadRequestException('Product schema must be an array');
    }

    const names = new Set<string>();
    for (const field of schema) {
      if (!field.name || typeof field.name !== 'string') {
        throw new BadRequestException('Each field must have a string name');
      }
      if (names.has(field.name)) {
        throw new BadRequestException(`Duplicate field name: ${field.name}`);
      }
      names.add(field.name);

      if (!['text', 'string', 'number', 'boolean', 'select'].includes(field.type)) {
        throw new BadRequestException(`Invalid field type for ${field.name}: ${field.type}`);
      }

      if (field.type === 'select' && (!Array.isArray(field.options) || field.options.length === 0)) {
        throw new BadRequestException(`Select field ${field.name} must have non-empty options array`);
      }
    }
  }

  async remove(id: string) {
    return this.prisma.tenant.delete({ where: { id } });
  }
}
