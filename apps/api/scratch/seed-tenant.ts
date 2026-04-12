import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenantId = 'restaurant-tenant';
  
  const existing = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (existing) {
    console.log("Tenant already exists!");
    return;
  }

  const tenant = await prisma.tenant.create({
    data: {
      id: tenantId,
      name: "Test Restaurant",
      businessType: "RESTAURANT",
      whatsappVerifyToken: "secret_verify_token",
      whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "test_phone_id",
      whatsappAccessToken: process.env.WHATSAPP_TEST_TOKEN || process.env.WHATSAPP_SYSTEM_TOKEN || "test_token",
      phone: "+1234567890",
      taxRate: 0.05
    }
  });

  console.log("Created Tenant:", tenant);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
