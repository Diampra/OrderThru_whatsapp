
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Enabling extensions...');
  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;');
    console.log('Extensions enabled successfully.');
  } catch (error) {
    console.error('Error enabling extensions:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
