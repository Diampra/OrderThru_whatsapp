import { Equals, IsBoolean, IsNotEmpty, IsString, Matches } from 'class-validator';

export class SendStickerDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d{10,15}$/, { message: 'phoneNumber must be 10-15 digits in E.164 format without +' })
  phoneNumber!: string;

  @IsNotEmpty()
  @IsString()
  stickerId!: string;

  @IsBoolean()
  @Equals(true, { message: 'consent must be true to send stickers' })
  consent!: boolean;
}
