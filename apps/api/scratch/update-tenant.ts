import { PrismaClient } from '@prisma/client';
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  const tenantId = 'restaurant-tenant';
  
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN
    }
  });

  console.log("Tenant updated with real token.");
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
