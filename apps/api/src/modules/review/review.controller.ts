import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReviewService } from './review.service';

@Controller('reviews')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  listDashboardReviews() {
    return this.reviewService.listDashboardReviews();
  }

  @Get(':itemName')
  getPublicSummary(@Param('itemName') itemName: string) {
    return this.reviewService.getReviewSummaryByItemName(itemName);
  }
}
