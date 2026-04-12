import { PrismaClient } from '@prisma/client';

async function setupTestTenant() {
  const prisma = new PrismaClient();
  
  // Find or create admin user
  const email = process.env.ADMIN_EMAIL ?? 'admin@example.com';
  let admin = await prisma.adminUser.findUnique({ where: { email } });
  
  if (!admin) {
    admin = await prisma.adminUser.create({
      data: {
        email,
        passwordHash: 'dummy',
      }
    });
  }

  // Update with dummy credentials
  admin = await prisma.adminUser.update({
    where: { id: admin.id },
    data: {
      whatsappVerifyToken: 'test_verify_token_123',
      whatsappPhoneNumberId: '1234567890',
      whatsappAccessToken: 'fake_access_token',
    }
  });

  console.log(`TENANT_ID=${admin.id}`);
  await prisma.$disconnect();
}

setupTestTenant().catch(console.error);
