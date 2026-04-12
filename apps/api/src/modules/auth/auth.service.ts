import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        profile: {
          include: {
            superAdmin: true,
            tenantAdmin: true,
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const profile = user.profile;
    const role = profile?.role ?? Role.TENANT_ADMIN;
    const tenantId = profile?.tenantAdmin?.tenantId ?? null;

    return {
      id: user.id,
      email: user.email,
      role,
      tenantId,
      profileId: profile?.id,
      name: profile ? `${profile.firstName} ${profile.lastName}`.trim() : user.email,
    };
  }

  async login(email: string, password: string) {
    const user = await this.validateUser(email, password);
    return {
      accessToken: await this.jwtService.signAsync({
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
      }),
      user,
    };
  }
}
