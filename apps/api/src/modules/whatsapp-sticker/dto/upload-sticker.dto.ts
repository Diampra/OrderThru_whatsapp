import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UploadStickerDto {
  @IsNotEmpty()
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
