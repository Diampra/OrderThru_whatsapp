import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.adminUser.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, passwordHash },
  });

  const menuItems = [
    {
      name: 'Margherita Pizza',
      description: 'Classic pizza with tomato, mozzarella, and basil.',
      price: 299,
    },
    {
      name: 'Paneer Tikka Wrap',
      description: 'Smoky paneer with onions, mint chutney, and salad.',
      price: 189,
    },
    {
      name: 'Cold Coffee',
      description: 'Creamy chilled coffee with vanilla ice cream.',
      price: 129,
    },
  ];

  for (const item of menuItems) {
    await prisma.menuItem.upsert({
      where: { name: item.name },
      update: {
        description: item.description,
        price: item.price,
        isAvailable: true,
      },
      create: {
        name: item.name,
        description: item.description,
        price: item.price,
        isAvailable: true,
      },
    });
  }
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
