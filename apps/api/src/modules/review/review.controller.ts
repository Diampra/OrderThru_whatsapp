import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ReviewService } from './review.service';

@Controller('reviews')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @Get()
  listDashboardReviews(
    @Req() req: any,
    @Query('rating') rating?: string,
    @Query('productId') productId?: string,
  ) {
    return this.reviewService.listDashboardReviews(req.user.tenantId, {
      rating: rating ? parseInt(rating, 10) : undefined,
      productId,
    });
  }

  @Get(':tenantId/:itemName')
  getPublicSummary(@Param('tenantId') tenantId: string, @Param('itemName') itemName: string) {
    return this.reviewService.getReviewSummaryByItemName(tenantId, itemName);
  }
}
