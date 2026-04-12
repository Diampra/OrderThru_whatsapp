import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenantId = 'restaurant-tenant';

  // Seed default products if none exist
  const count = await prisma.product.count({ where: { tenantId } });
  if (count === 0) {
    console.log("No products found! Seeding some test products...");
    await prisma.product.createMany({
      data: [
        {
          tenantId,
          name: "Margherita Pizza",
          description: "Classic pizza with tomato and mozzarella",
          price: 250,
          category: "Pizza",
          tags: ["pizza", "veg"]
        },
        {
          tenantId,
          name: "Farmhouse Pizza",
          description: "Loaded with fresh vegetables",
          price: 350,
          category: "Pizza",
          tags: ["pizza", "veg"]
        },
        {
          tenantId,
          name: "Cappuccino",
          description: "Hot frothy coffee",
          price: 150,
          category: "Beverages",
          tags: ["coffee", "hot"]
        }
      ]
    });
    console.log("Seeded 3 products for testing.");
  } else {
    console.log(`Found ${count} products.`);
  }

  // Update categories array just in case
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      categories: ["Pizza", "Beverages", "Burgers"]
    }
  });

  console.log("Tenant categories updated.");
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
