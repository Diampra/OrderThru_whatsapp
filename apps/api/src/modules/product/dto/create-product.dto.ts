import { IsArray, IsBoolean, IsNumber, IsOptional, IsObject, IsString, Min } from 'class-validator';

export class CreateProductDto {
  @IsString()
  name!: string;

  @IsString()
  description!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsString()
  category!: string;

  @IsOptional()
  @IsBoolean()
  isVeg?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxRate?: number;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  attributes?: Record<string, any>;
}
