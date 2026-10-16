require("dotenv").config();
const { PrismaClient, UserRole, ProductCategory } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient();
(async () => {
  const passwordHash = await bcrypt.hash("TroqueEstaSenha123!", 12);
  const admin = await prisma.user.upsert({
    where: { email: "admin@agrovende.local" },
    update: {},
    create: { name: "Administrador de demonstração", email: "admin@agrovende.local", passwordHash, role: UserRole.ADMIN }
  });
  const seller = await prisma.user.upsert({
    where: { email: "vendedor@agrovende.local" },
    update: {},
    create: { name: "Vendedor de demonstração", email: "vendedor@agrovende.local", passwordHash, role: UserRole.SELLER,
      store: { create: { name: "Agro Campo Forte", slug: "agro-campo-forte", description: "Loja de demonstração. Produtos ilustrativos." } } }
  });
  const store = await prisma.store.findUnique({ where: { ownerId: seller.id } });
  const count = await prisma.product.count({ where: { storeId: store.id } });
  if (!count) await prisma.product.createMany({ data: [
    {storeId:store.id,name:"Fertilizante NPK 10-10-10",slug:"fertilizante-npk-10-10-10",description:"Produto de demonstração. Confirme registro, composição e uso com o fornecedor.",category:ProductCategory.NPK,priceCents:18990,stock:35,unit:"saco de 25 kg"},
    {storeId:store.id,name:"Composto Orgânico Premium",slug:"composto-organico-premium",description:"Produto de demonstração. Consulte as especificações e recomendações do fabricante.",category:ProductCategory.ORGANIC,priceCents:6490,stock:80,unit:"saco de 20 kg"}
  ]});
  console.log("Seed concluído. Admin:", admin.email, "| vendedor:", seller.email, "| senha de demonstração: TroqueEstaSenha123!");
})().catch(e=>{console.error(e);process.exit(1)}).finally(()=>prisma.$disconnect());
