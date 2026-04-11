import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateMenuItemDto {
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
}
