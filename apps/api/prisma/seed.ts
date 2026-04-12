import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com';
  const superAdminEmail = 'super@example.com';
  const password = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(password, 10);

  console.log('Seed: Creating/Updating Super Admin User...');
  const superUser = await prisma.user.upsert({
    where: { email: superAdminEmail },
    update: { passwordHash },
    create: { email: superAdminEmail, passwordHash },
  });

  const superProfile = await prisma.profile.upsert({
    where: { userId: superUser.id },
    update: { role: Role.SUPER_ADMIN, firstName: 'Super', lastName: 'Admin' },
    create: { userId: superUser.id, role: Role.SUPER_ADMIN, firstName: 'Super', lastName: 'Admin' },
  });

  await prisma.superAdmin.upsert({
    where: { profileId: superProfile.id },
    update: {},
    create: { profileId: superProfile.id },
  });

  const tenants = [
    {
      id: 'restaurant-tenant',
      name: 'Gourmet Bistro',
      businessType: 'RESTAURANT',
      whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
      schema: [
        { name: 'isVeg', label: 'Vegetarian', type: 'boolean', required: true, displayInList: true },
        { name: 'spiceLevel', label: 'Spice Level', type: 'select', options: ['Mild', 'Medium', 'Hot'], required: false },
        { name: 'calories', label: 'Calories', type: 'number', required: false },
      ],
      products: [
        { name: 'Margherita Pizza', price: 499, attributes: { isVeg: true, spiceLevel: 'Mild', calories: 800 } },
        { name: 'Spicy Arrabbiata', price: 399, attributes: { isVeg: true, spiceLevel: 'Hot', calories: 600 } },
      ],
    },
    {
      id: 'clothing-tenant',
      name: 'Urban Threads',
      businessType: 'CLOTHING',
      schema: [
        { name: 'size', label: 'Size', type: 'select', options: ['S', 'M', 'L', 'XL'], required: true, displayInList: true },
        { name: 'color', label: 'Color', type: 'text', required: true },
        { name: 'material', label: 'Material', type: 'text', required: false },
      ],
      products: [
        { name: 'Classic White Tee', price: 999, attributes: { size: 'M', color: 'White', material: 'Cotton' } },
        { name: 'Denim Jacket', price: 2499, attributes: { size: 'L', color: 'Blue', material: 'Denim' } },
      ],
    },
  ];

  for (const t of tenants) {
    console.log(`Seed: Creating tenant ${t.name}...`);
    const tenant = await prisma.tenant.upsert({
      where: { id: t.id },
      update: { 
        name: t.name, 
        businessType: t.businessType, 
        productSchema: t.schema as any,
        whatsappPhoneNumberId: (t as any).whatsappPhoneNumberId,
        whatsappAccessToken: (t as any).whatsappAccessToken,
        whatsappVerifyToken: (t as any).whatsappVerifyToken,
        razorpayKeyId: (t as any).razorpayKeyId,
        razorpayKeySecret: (t as any).razorpayKeySecret,
      },
      create: { 
        id: t.id, 
        name: t.name, 
        businessType: t.businessType, 
        productSchema: t.schema as any,
        whatsappPhoneNumberId: (t as any).whatsappPhoneNumberId,
        whatsappAccessToken: (t as any).whatsappAccessToken,
        whatsappVerifyToken: (t as any).whatsappVerifyToken,
        razorpayKeyId: (t as any).razorpayKeyId,
        razorpayKeySecret: (t as any).razorpayKeySecret,
      },
    });

    // Create a specific admin for this tenant
    if (t.id === 'restaurant-tenant') {
      const tenantUser = await prisma.user.upsert({
        where: { email: adminEmail },
        update: { passwordHash },
        create: { email: adminEmail, passwordHash },
      });

      const tenantProfile = await prisma.profile.upsert({
        where: { userId: tenantUser.id },
        update: { role: Role.TENANT_ADMIN, firstName: 'Tenant', lastName: 'Admin' },
        create: { userId: tenantUser.id, role: Role.TENANT_ADMIN, firstName: 'Tenant', lastName: 'Admin' },
      });

      await prisma.tenantAdmin.upsert({
        where: { profileId: tenantProfile.id },
        update: { tenantId: tenant.id },
        create: { profileId: tenantProfile.id, tenantId: tenant.id },
      });
    }

    for (const p of t.products) {
      await prisma.product.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: p.name } },
        update: { price: p.price, attributes: p.attributes as any, description: `High quality ${p.name}` },
        create: {
          tenantId: tenant.id,
          name: p.name,
          price: p.price,
          description: `High quality ${p.name}`,
          attributes: p.attributes as any,
        },
      });
    }
  }

  console.log('Seed: Finished successfully.');
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
