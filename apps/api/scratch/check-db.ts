import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany();
  console.log("Tenants:", tenants.map(t => ({
    id: t.id,
    name: t.name,
    hasToken: !!t.whatsappAccessToken,
    hasPhoneId: !!t.whatsappPhoneNumberId
  })));

  const logs = await prisma.unknownIntentLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log("Recent UnknownIntentLogs:", logs);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
