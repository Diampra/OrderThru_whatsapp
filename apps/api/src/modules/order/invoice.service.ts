import { Injectable, NotFoundException } from '@nestjs/common';
// @ts-ignore
import PDFDocument = require('pdfkit');
import { formatInr } from '../../common/utils/currency';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  async generateInvoice(orderId: string): Promise<Buffer> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        tenant: true,
        orderItems: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // --- Header ---
      doc
        .fillColor('#444444')
        .fontSize(20)
        .text(order.tenant.name, 50, 50)
        .fontSize(10)
        .text(order.tenant.id.toUpperCase(), 50, 75)
        .text('Generated via OrderThru', 50, 90)
        .moveDown();

      doc
        .fillColor('#444444')
        .fontSize(25)
        .text('INVOICE', 50, 50, { align: 'right' })
        .fontSize(10)
        .text(`Order ID: #${order.id.slice(-6).toUpperCase()}`, 50, 80, { align: 'right' })
        .text(`Date: ${order.createdAt.toLocaleDateString()}`, 50, 95, { align: 'right' })
        .moveDown();

      doc.moveTo(50, 120).lineTo(550, 120).stroke('#eeeeee');

      // --- Billing Details ---
      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('BILL TO:', 50, 140)
        .font('Helvetica')
        .fontSize(10)
        .text(`Phone: ${order.customerPhone}`, 50, 155)
        .moveDown();

      // --- Table Header ---
      const tableTop = 200;
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('Item', 50, tableTop)
        .text('Qty', 280, tableTop, { width: 50, align: 'right' })
        .text('Price', 330, tableTop, { width: 70, align: 'right' })
        .text('Tax', 400, tableTop, { width: 70, align: 'right' })
        .text('Total', 470, tableTop, { width: 80, align: 'right' });

      doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke('#eeeeee');

      // --- Table Rows ---
      let currentTop = tableTop + 25;
      order.orderItems.forEach((item) => {
        const itemTotal = (Number(item.unitPrice) * item.quantity) + Number(item.taxAmount);
        
        doc
          .font('Helvetica')
          .fontSize(10)
          .text(item.product.name, 50, currentTop, { width: 220 })
          .text(item.quantity.toString(), 280, currentTop, { width: 50, align: 'right' })
          .text(formatInr(Number(item.unitPrice)), 330, currentTop, { width: 70, align: 'right' })
          .text(formatInr(Number(item.taxAmount)), 400, currentTop, { width: 70, align: 'right' })
          .text(formatInr(itemTotal), 470, currentTop, { width: 80, align: 'right' });

        currentTop += 20;
      });

      // --- Summary ---
      const subtotal = order.orderItems.reduce((acc, i) => acc + (Number(i.unitPrice) * i.quantity), 0);
      const totalTax = order.orderItems.reduce((acc, i) => acc + Number(i.taxAmount), 0);

      const summaryTop = currentTop + 30;
      doc.moveTo(330, summaryTop).lineTo(550, summaryTop).stroke('#eeeeee');

      doc
        .fontSize(10)
        .text('Subtotal:', 330, summaryTop + 10)
        .text(formatInr(subtotal), 470, summaryTop + 10, { width: 80, align: 'right' })
        
        .text('Total Tax:', 330, summaryTop + 25)
        .text(formatInr(totalTax), 470, summaryTop + 25, { width: 80, align: 'right' });

      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('Grand Total:', 330, summaryTop + 45)
        .text(formatInr(Number(order.totalAmount)), 470, summaryTop + 45, { width: 80, align: 'right' });

      // --- Footer ---
      doc
        .fontSize(10)
        .fillColor('#aaaaaa')
        .text('Thank you for your business! Hope to serve you again.', 50, 700, { align: 'center', width: 500 });

      doc.end();
    });
  }

  async generateMenuPdf(tenantId: string): Promise<Buffer> {
    const products = await this.prisma.product.findMany({
      where: { tenantId, isAvailable: true },
      include: { tenant: true },
      orderBy: { category: 'asc' },
    });

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) throw new NotFoundException('Tenant not found');

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // --- Header ---
      doc
        .fillColor('#444444')
        .fontSize(25)
        .font('Helvetica-Bold')
        .text(tenant.name.toUpperCase(), { align: 'center' })
        .fontSize(12)
        .font('Helvetica')
        .text('DIGITAL MENU', { align: 'center' })
        .moveDown();

      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#eeeeee').moveDown();

      // --- Group by Category ---
      const categories = [...new Set(products.map((p) => p.category))];

      categories.forEach((category) => {
        const categoryProducts = products.filter((p) => p.category === category);
        
        // Category Header
        doc
          .moveDown()
          .fontSize(16)
          .font('Helvetica-Bold')
          .fillColor('#indigo')
          .text(category.toUpperCase(), { underline: true })
          .moveDown(0.5);

        categoryProducts.forEach((product) => {
          const startY = doc.y;
          
          // Row 1: Name & Price
          doc
            .fontSize(12)
            .font('Helvetica-Bold')
            .fillColor('#333333')
            .text(`${product.isVeg ? '🟢' : '🔴'} ${product.name}`, 50, startY)
            .text(formatInr(Number(product.price)), 450, startY, { align: 'right' });

          // Row 2: Description
          if (product.description) {
            doc
              .fontSize(9)
              .font('Helvetica')
              .fillColor('#777777')
              .text(product.description, 70, doc.y + 2, { width: 350 });
          }

          doc.moveDown(1);

          // Page break check
          if (doc.y > 700) doc.addPage();
        });
      });

      // --- Footer ---
      doc
        .fontSize(10)
        .fillColor('#aaaaaa')
        .text('Generated via OrderThru • Simply scans, order & pay.', 50, 750, { align: 'center', width: 500 });

      doc.end();
    });
  }
}
