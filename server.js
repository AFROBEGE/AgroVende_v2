require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const slugify = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
const { z } = require("zod");
const {
  PrismaClient,
  UserRole,
  ProductCategory,
  PaymentMethod,
  OrderStatus,
  PaymentStatus,
} = require("@prisma/client");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("Configure JWT_SECRET com pelo menos 32 caracteres no .env.");
  process.exit(1);
}
const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT || 3000);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/uploads",
  express.static(uploadDir, { fallthrough: false, maxAge: "1d" }),
);
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 250,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  message: { error: "Muitas tentativas. Tente novamente mais tarde." },
});
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: "7d",
    issuer: "agrovende",
  });
}
async function auth(req, res, next) {
  try {
    const token =
      req.cookies.agv_session ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token)
      return res.status(401).json({ error: "Faça login para continuar." });
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: "agrovende",
    });
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { store: true },
    });
    if (!user) return res.status(401).json({ error: "Sessão inválida." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Sessão inválida ou expirada." });
  }
}
const role =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res
          .status(403)
          .json({ error: "Você não tem permissão para esta ação." });
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const productSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().min(8).max(3000),
  category: z.nativeEnum(ProductCategory),
  priceCents: z.number().int().positive().max(100000000),
  stock: z.number().int().min(0).max(1000000),
  unit: z.string().trim().min(1).max(60),
  imageUrl: z.string().max(500).optional().nullable(),
});
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) =>
      cb(
        null,
        `${Date.now()}-${require("crypto").randomBytes(8).toString("hex")}${path.extname(file.originalname).toLowerCase()}`,
      ),
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)),
});

app.get("/api/health", (req, res) =>
  res.json({ status: "ok", name: "AgroVende API" }),
);
app.post(
  "/api/auth/register",
  authLimiter,
  asyncRoute(async (req, res) => {
    const schema = z.object({
      name: z.string().trim().min(2).max(100),
      email: z.string().trim().email().max(254),
      password: z.string().min(10).max(100),
      role: z.enum(["CUSTOMER", "SELLER"]),
      storeName: z.string().trim().min(2).max(100).optional(),
    });
    const data = schema.parse(req.body);
    const email = data.email.toLowerCase();
    if (data.role === "SELLER" && !data.storeName)
      return res.status(400).json({ error: "Informe o nome da loja." });
    if (await prisma.user.findUnique({ where: { email } }))
      return res.status(409).json({ error: "Este e-mail já está cadastrado." });
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        name: data.name,
        email,
        passwordHash,
        role: data.role,
        ...(data.role === "SELLER"
          ? {
              store: {
                create: {
                  name: data.storeName,
                  slug: `${slugify(data.storeName)}-${Math.random().toString(36).slice(2, 7)}`,
                },
              },
            }
          : {}),
      },
      include: { store: true },
    });
    res
      .cookie("agv_session", signToken(user), cookieOptions)
      .status(201)
      .json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          store: user.store,
        },
      });
  }),
);
app.post(
  "/api/auth/login",
  authLimiter,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        email: z.string().email(),
        password: z.string().min(1).max(100),
      })
      .parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
      include: { store: true },
    });
    if (!user || !(await bcrypt.compare(data.password, user.passwordHash)))
      return res.status(401).json({ error: "E-mail ou senha inválidos." });
    res
      .cookie("agv_session", signToken(user), cookieOptions)
      .json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          store: user.store,
        },
      });
  }),
);
app.post("/api/auth/logout", (req, res) =>
  res
    .clearCookie("agv_session", {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    })
    .json({ ok: true }),
);
app.get("/api/auth/me", auth, (req, res) =>
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      store: req.user.store,
    },
  }),
);

app.get(
  "/api/products",
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1),
      limit = Math.min(48, Math.max(1, Number(req.query.limit) || 12));
    const where = {
      active: true,
      store: { active: true },
      ...(req.query.category &&
      Object.values(ProductCategory).includes(req.query.category)
        ? { category: req.query.category }
        : {}),
      ...(req.query.q
        ? {
            OR: [
              { name: { contains: String(req.query.q), mode: "insensitive" } },
              {
                description: {
                  contains: String(req.query.q),
                  mode: "insensitive",
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { store: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.product.count({ where }),
    ]);
    res.json({ items, total, page, pages: Math.ceil(total / limit) });
  }),
);
app.get(
  "/api/products/:id",
  asyncRoute(async (req, res) => {
    const p = await prisma.product.findFirst({
      where: { id: req.params.id, active: true, store: { active: true } },
      include: {
        store: { select: { name: true, slug: true, description: true } },
      },
    });
    if (!p) return res.status(404).json({ error: "Produto não encontrado." });
    res.json({ product: p });
  }),
);
app.get(
  "/api/seller/products",
  auth,
  role("SELLER", "ADMIN"),
  asyncRoute(async (req, res) => {
    if (!req.user.store)
      return res
        .status(400)
        .json({ error: "Sua conta não tem uma loja vinculada." });
    res.json({
      items: await prisma.product.findMany({
        where: req.user.role === "ADMIN" ? {} : { storeId: req.user.store.id },
        orderBy: { createdAt: "desc" },
      }),
    });
  }),
);
app.post(
  "/api/seller/products",
  auth,
  role("SELLER", "ADMIN"),
  asyncRoute(async (req, res) => {
    if (!req.user.store)
      return res
        .status(400)
        .json({ error: "Sua conta não tem uma loja vinculada." });
    const data = productSchema.parse(req.body),
      base = slugify(data.name) || "produto";
    let slug = base,
      n = 1;
    while (
      await prisma.product.findUnique({
        where: { storeId_slug: { storeId: req.user.store.id, slug } },
      })
    )
      slug = `${base}-${++n}`;
    const product = await prisma.product.create({
      data: { ...data, slug, storeId: req.user.store.id },
    });
    res.status(201).json({ product });
  }),
);
app.patch(
  "/api/seller/products/:id",
  auth,
  role("SELLER", "ADMIN"),
  asyncRoute(async (req, res) => {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
    });
    if (!existing)
      return res.status(404).json({ error: "Produto não encontrado." });
    if (req.user.role !== "ADMIN" && existing.storeId !== req.user.store?.id)
      return res
        .status(403)
        .json({ error: "Este produto pertence a outra loja." });
    const data = productSchema.partial().parse(req.body);
    const product = await prisma.product.update({
      where: { id: existing.id },
      data,
    });
    res.json({ product });
  }),
);
app.delete(
  "/api/seller/products/:id",
  auth,
  role("SELLER", "ADMIN"),
  asyncRoute(async (req, res) => {
    const p = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: "Produto não encontrado." });
    if (req.user.role !== "ADMIN" && p.storeId !== req.user.store?.id)
      return res
        .status(403)
        .json({ error: "Este produto pertence a outra loja." });
    await prisma.product.update({
      where: { id: p.id },
      data: { active: false },
    });
    res.json({ ok: true });
  }),
);
app.post(
  "/api/seller/upload",
  auth,
  role("SELLER", "ADMIN"),
  upload.single("image"),
  (req, res) => {
    if (!req.file)
      return res
        .status(400)
        .json({ error: "Envie uma imagem JPG, PNG ou WebP de até 3 MB." });
    res.status(201).json({ imageUrl: `/uploads/${req.file.filename}` });
  },
);
app.get(
  "/api/seller/dashboard",
  auth,
  role("SELLER", "ADMIN"),
  asyncRoute(async (req, res) => {
    if (!req.user.store)
      return res.status(400).json({ error: "Conta sem loja vinculada." });
    const where = { storeId: req.user.store.id };
    const [products, units] = await Promise.all([
      prisma.product.count({ where: { ...where, active: true } }),
      prisma.product.aggregate({
        where: { ...where, active: true },
        _sum: { stock: true },
      }),
    ]);
    res.json({
      store: req.user.store,
      stats: {
        products,
        unitsInStock: units._sum.stock || 0,
        sales: 0,
        note: "Relatório de vendas será alimentado quando o fluxo de pedidos e pagamentos estiver homologado.",
      },
    });
  }),
);

app.post(
  "/api/orders/checkout",
  auth,
  role("CUSTOMER"),
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        items: z
          .array(
            z.object({
              productId: z.string().min(1),
              quantity: z.number().int().min(1).max(1000),
            }),
          )
          .min(1)
          .max(50),
        paymentMethod: z.nativeEnum(PaymentMethod),
      })
      .parse(req.body);
    const aggregated = new Map();
    for (const item of data.items)
      aggregated.set(
        item.productId,
        (aggregated.get(item.productId) || 0) + item.quantity,
      );
    const ids = [...aggregated.keys()];
    const products = await prisma.product.findMany({
      where: { id: { in: ids }, active: true, store: { active: true } },
      include: { store: { select: { name: true } } },
    });
    if (products.length !== ids.length)
      return res
        .status(400)
        .json({ error: "Um ou mais produtos não estão disponíveis." });
    for (const p of products)
      if (p.stock < aggregated.get(p.id))
        return res
          .status(409)
          .json({ error: `Estoque insuficiente para ${p.name}.` });
    const subtotalCents = products.reduce(
      (sum, p) => sum + p.priceCents * aggregated.get(p.id),
      0,
    );
    const order = await prisma.order.create({
      data: {
        customerId: req.user.id,
        subtotalCents,
        shippingCents: 0,
        totalCents: subtotalCents,
        paymentMethod: data.paymentMethod,
        items: {
          create: products.map((p) => ({
            productId: p.id,
            storeName: p.store.name,
            productName: p.name,
            unitPriceCents: p.priceCents,
            quantity: aggregated.get(p.id),
          })),
        },
      },
    });
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!mpToken) {
      return res
        .status(201)
        .json({
          orderId: order.id,
          status: "PENDING",
          checkoutUrl: null,
          message:
            "Pedido de teste criado. Configure MERCADOPAGO_ACCESS_TOKEN para ativar o checkout.",
        });
    }
    const client = new MercadoPagoConfig({ accessToken: mpToken });
    const preference = new Preference(client);
    const preferenceResult = await preference.create({
      body: {
        external_reference: order.id,
        items: products.map((p) => ({
          id: p.id,
          title: p.name,
          quantity: aggregated.get(p.id),
          unit_price: p.priceCents / 100,
          currency_id: "BRL",
        })),
        payer: { email: req.user.email, name: req.user.name },
        payment_methods: {
          excluded_payment_types: {
            PIX: [{ id: "credit_card" }, { id: "ticket" }],
            CREDIT_CARD: [{ id: "bank_transfer" }, { id: "ticket" }],
            BOLETO: [{ id: "credit_card" }, { id: "bank_transfer" }],
          }[data.paymentMethod],
          installments: 12,
        },
        back_urls: {
          success: `${process.env.APP_URL}/?payment=success`,
          failure: `${process.env.APP_URL}/?payment=failure`,
          pending: `${process.env.APP_URL}/?payment=pending`,
        },
        auto_return: "approved",
        notification_url: `${process.env.APP_URL}/api/payments/mercadopago-webhook`,
      },
    });
    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentProviderId: String(preferenceResult.id),
        checkoutUrl: preferenceResult.init_point || null,
      },
    });
    res
      .status(201)
      .json({
        orderId: order.id,
        status: "PENDING",
        checkoutUrl: preferenceResult.init_point,
      });
  }),
);
app.get(
  "/api/orders",
  auth,
  asyncRoute(async (req, res) => {
    const orders = await prisma.order.findMany({
      where: req.user.role === "ADMIN" ? {} : { customerId: req.user.id },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ items: orders });
  }),
);
app.post(
  "/api/payments/mercadopago-webhook",
  asyncRoute(async (req, res) => {
    // TODO produção: validar assinatura x-signature conforme documentação oficial do Mercado Pago
    // e consultar o pagamento na API antes de alterar o status. Não confiar apenas no corpo recebido.
    const paymentId = req.query["data.id"] || req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) return res.sendStatus(200);
    const client = new MercadoPagoConfig({
      accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
    });
    const payment = await new Payment(client).get({ id: String(paymentId) });
    const orderId = payment.external_reference;
    if (!orderId) return res.sendStatus(200);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return res.sendStatus(200);
    if (
      payment.status === "approved" &&
      order.paymentStatus !== PaymentStatus.APPROVED
    ) {
      await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          const changed = await tx.product.updateMany({
            where: { id: item.productId, stock: { gte: item.quantity } },
            data: { stock: { decrement: item.quantity } },
          });
          if (changed.count !== 1)
            throw new Error("Estoque insuficiente ao confirmar pagamento");
        }
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: PaymentStatus.APPROVED,
            status: OrderStatus.PAID,
            paymentProviderId: String(payment.id),
          },
        });
      });
    } else if (payment.status === "rejected") {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: PaymentStatus.REJECTED,
          status: OrderStatus.PAYMENT_FAILED,
          paymentProviderId: String(payment.id),
        },
      });
    }
    res.sendStatus(200);
  }),
);
app.get(
  "/api/stores/:slug",
  asyncRoute(async (req, res) => {
    const store = await prisma.store.findUnique({
      where: { slug: req.params.slug },
      include: {
        products: { where: { active: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!store || !store.active)
      return res.status(404).json({ error: "Loja não encontrada." });
    res.json({
      store: {
        id: store.id,
        name: store.name,
        slug: store.slug,
        description: store.description,
      },
      products: store.products,
    });
  }),
);

app.get(/.*/, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);
app.use((err, req, res, next) => {
  if (err instanceof z.ZodError)
    return res
      .status(400)
      .json({
        error: "Dados inválidos.",
        details: err.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
  if (err instanceof multer.MulterError)
    return res
      .status(400)
      .json({
        error:
          err.code === "LIMIT_FILE_SIZE"
            ? "A imagem excede 3 MB."
            : "Não foi possível receber a imagem.",
      });
  console.error(err);
  res.status(500).json({ error: "Erro interno. Tente novamente." });
});
app.listen(PORT, () =>
  console.log(`AgroVende rodando em http://localhost:${PORT}`),
);
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
