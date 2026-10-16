const $ = (s) => document.querySelector(s);
const money = (c) =>
  (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let me = null,
  products = [];
async function api(url, options = {}) {
  const r = await fetch("/api" + url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Ocorreu um erro.");
  return data;
}
function toast(m) {
  const t = $("#toast");
  t.textContent = m;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2500);
}
function showModal(html) {
  $("#modalContent").innerHTML = html;
  $("#modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeModal() {
  $("#modal").classList.add("hidden");
  document.body.style.overflow = "";
}
$("#closeModal").onclick = closeModal;
$("#modal").onclick = (e) => {
  if (e.target.id === "modal") closeModal();
};
async function loadProducts() {
  try {
    const q = $("#search").value.trim(),
      category = $("#category").value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (category) params.set("category", category);
    const data = await api("/products?" + params);
    products = data.items;
    $("#products").innerHTML = products.length
      ? products
          .map(
            (p) =>
              `<article class="card"><div class="prod-img">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}">` : "🌱"}</div><div class="card-body"><small>${esc(p.category)} · ${esc(p.store.name)}</small><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="price">${money(p.priceCents)}</div><span class="unit">por ${esc(p.unit)} · estoque ${p.stock}</span><button class="gradient" data-buy="${esc(p.id)}">Comprar</button></div></article>`,
          )
          .join("")
      : "<p>Nenhum produto encontrado. Experimente outra busca.</p>";
    document
      .querySelectorAll("[data-buy]")
      .forEach((b) => (b.onclick = () => startCheckout(b.dataset.buy)));
  } catch (e) {
    $("#products").innerHTML =
      `<p>Não foi possível carregar o catálogo: ${esc(e.message)}</p>`;
  }
}
$("#searchForm").onsubmit = (e) => {
  e.preventDefault();
  loadProducts();
};
$("#category").onchange = loadProducts;
function authForm(mode = "login", role = "CUSTOMER") {
  showModal(
    `<span class="eyebrow">ACESSO À PLATAFORMA</span><h2>${mode === "login" ? "Entrar no AgroVende" : "Criar sua conta"}</h2><div class="role-select"><label>Tipo de conta<select id="authRole"><option value="CUSTOMER" ${role === "CUSTOMER" ? "selected" : ""}>Cliente</option><option value="SELLER" ${role === "SELLER" ? "selected" : ""}>Vendedor — minha própria loja</option></select></label></div><form id="authForm">${mode === "register" ? `<label>Nome completo<input id="name" required minlength="2" maxlength="100"></label><label id="storeWrap" class="${role === "SELLER" ? "" : "hidden"}">Nome da loja<input id="storeName" maxlength="100"></label>` : ""}<label>E-mail<input id="email" type="email" required autocomplete="email"></label><label>Senha<input id="password" type="password" required minlength="${mode === "register" ? 10 : 1}" autocomplete="${mode === "login" ? "current-password" : "new-password"}" placeholder="${mode === "register" ? "Mínimo de 10 caracteres" : ""}"></label><button class="gradient">${mode === "login" ? "Entrar" : "Criar conta"}</button></form><p class="switch">${mode === "login" ? "Ainda não tem conta?" : "Já tem conta?"} <button id="switchMode">${mode === "login" ? "Criar conta" : "Entrar"}</button></p>`,
  );
  $("#authRole").onchange = () => {
    if ($("#storeWrap") && mode === "register")
      $("#storeWrap").classList.toggle(
        "hidden",
        $("#authRole").value !== "SELLER",
      );
  };
  $("#switchMode").onclick = () =>
    authForm(mode === "login" ? "register" : "login", $("#authRole").value);
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault();
    const r = $("#authRole").value,
      body = {
        email: $("#email").value.trim(),
        password: $("#password").value,
      };
    if (mode === "register") {
      body.name = $("#name").value.trim();
      body.role = r;
      if (r === "SELLER") body.storeName = $("#storeName").value.trim();
    }
    try {
      const d = await api(
        "/auth/" + (mode === "login" ? "login" : "register"),
        { method: "POST", body: JSON.stringify(body) },
      );
      me = d.user;
      closeModal();
      toast("Acesso realizado!");
      updateHeader();
      if (me.role === "SELLER" || me.role === "ADMIN") sellerDashboard();
      else customerDashboard();
    } catch (err) {
      toast(err.message);
    }
  };
}
function updateHeader() {
  $("#loginBtn").textContent = me ? "Minha área" : "Entrar";
  $("#loginBtn").onclick = () =>
    me
      ? me.role === "SELLER" || me.role === "ADMIN"
        ? sellerDashboard()
        : customerDashboard()
      : authForm();
  $("#registerBtn").onclick = () => authForm("register");
  $("#ordersBtn").onclick = () => (me ? orders() : authForm());
  $("#sellBtn").onclick = () =>
    me?.role === "SELLER" ? sellerDashboard() : authForm("register", "SELLER");
  $("#sellerBtn").onclick = () =>
    me?.role === "SELLER" ? sellerDashboard() : authForm("login", "SELLER");
}
async function refreshMe() {
  try {
    me = (await api("/auth/me")).user;
  } catch {
    me = null;
  }
  updateHeader();
}
async function sellerDashboard() {
  try {
    if (!me) return authForm("login", "SELLER");
    if (me.role !== "SELLER" && me.role !== "ADMIN")
      return toast("Entre com uma conta de vendedor.");
    const [d, list] = await Promise.all([
      api("/seller/dashboard"),
      api("/seller/products"),
    ]);
    showModal(
      `<span class="eyebrow">PAINEL DO VENDEDOR</span><h2>${esc(d.store.name)}</h2><p>Gerencie seus produtos e estoque.</p><div class="statrow"><div class="stat"><small>Produtos ativos</small><b>${d.stats.products}</b></div><div class="stat"><small>Unidades em estoque</small><b>${d.stats.unitsInStock}</b></div><div class="stat"><small>Vendas</small><b>${d.stats.sales}</b></div></div><div class="dashboard"><section class="panel"><h3>＋ Cadastrar produto</h3><form id="productForm"><label>Nome<input id="pName" required minlength="3" maxlength="120"></label><label>Categoria<select id="pCategory"><option value="NPK">Fertilizantes NPK</option><option value="ORGANIC">Orgânicos</option><option value="FOLIAR">Nutrição foliar</option><option value="SOIL">Condicionadores de solo</option><option value="SEEDS">Sementes</option><option value="OTHER">Outros</option></select></label><label>Preço em reais<input id="pPrice" type="number" min=".01" step=".01" required></label><label>Unidade/embalagem<input id="pUnit" placeholder="Saco de 25 kg" required></label><label>Estoque<input id="pStock" type="number" min="0" value="1" required></label><label>Descrição<textarea id="pDescription" minlength="8" maxlength="3000" required></textarea></label><label>Foto do produto (JPG/PNG/WebP, até 3 MB)<input id="pImage" type="file" accept="image/jpeg,image/png,image/webp"></label><button class="gradient">Publicar produto</button></form></section><section class="panel"><h3>Meus anúncios (${list.items.length})</h3><div id="inventory">${list.items.map((p) => `<div class="inventory">${esc(p.name)}<br><small>${esc(p.category)} · estoque ${p.stock} · ${money(p.priceCents)}</small><button data-delete="${esc(p.id)}">Remover</button></div>`).join("") || "<p>Você ainda não tem anúncios.</p>"}</div></section></div><p class="note">Antes de publicar, confira se o produto está regularizado e se as informações e fotos são corretas.</p><button class="outline" id="logout">Sair da conta</button>`,
    );
    $("#productForm").onsubmit = async (e) => {
      e.preventDefault();
      try {
        let imageUrl = null;
        const f = $("#pImage").files[0];
        if (f) {
          const fd = new FormData();
          fd.append("image", f);
          const uploaded = await fetch("/api/seller/upload", {
            method: "POST",
            credentials: "same-origin",
            body: fd,
          });
          const up = await uploaded.json();
          if (!uploaded.ok) throw new Error(up.error || "Falha ao enviar foto");
          imageUrl = up.imageUrl;
        }
        const body = {
          name: $("#pName").value.trim(),
          category: $("#pCategory").value,
          priceCents: Math.round(Number($("#pPrice").value) * 100),
          unit: $("#pUnit").value.trim(),
          stock: Number($("#pStock").value),
          description: $("#pDescription").value.trim(),
          imageUrl,
        };
        await api("/seller/products", {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast("Produto publicado!");
        sellerDashboard();
        loadProducts();
      } catch (err) {
        toast(err.message);
      }
    };
    document.querySelectorAll("[data-delete]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm("Remover este anúncio?")) return;
          try {
            await api("/seller/products/" + b.dataset.delete, {
              method: "DELETE",
            });
            sellerDashboard();
            loadProducts();
            toast("Anúncio removido.");
          } catch (e) {
            toast(e.message);
          }
        }),
    );
    $("#logout").onclick = logout;
  } catch (e) {
    toast(e.message);
  }
}
async function customerDashboard() {
  showModal(
    `<span class="eyebrow">ÁREA DO CLIENTE</span><h2>Olá, ${esc(me.name)}!</h2><p>Consulte seus pedidos e explore o catálogo.</p><button class="gradient" id="viewOrders">Ver meus pedidos</button> <button class="outline" id="logout">Sair</button>`,
  );
  $("#viewOrders").onclick = orders;
  $("#logout").onclick = logout;
}
async function orders() {
  try {
    if (!me) return authForm();
    const d = await api("/orders");
    showModal(
      `<span class="eyebrow">MINHA CONTA</span><h2>Meus pedidos</h2>${d.items.length ? d.items.map((o) => `<div class="inventory"><b>Pedido ${esc(o.id)}</b><br>${esc(o.status)} · ${money(o.totalCents)} · ${new Date(o.createdAt).toLocaleDateString("pt-BR")}</div>`).join("") : "<p>Você ainda não tem pedidos.</p>"}<button class="outline" id="backAccount">Voltar</button>`,
    );
    $("#backAccount").onclick = customerDashboard;
  } catch (e) {
    toast(e.message);
  }
}
async function startCheckout(productId) {
  if (!me) {
    authForm();
    toast("Entre como cliente para continuar.");
    return;
  }
  if (me.role !== "CUSTOMER") {
    toast("O checkout deve ser feito em uma conta de cliente.");
    return;
  }
  showModal(
    `<span class="eyebrow">FINALIZAR PEDIDO</span><h2>Escolha o pagamento</h2><p>Produto: ${esc(products.find((p) => p.id === productId)?.name || "Produto")}</p><form id="checkoutForm"><label>Quantidade<input id="quantity" type="number" min="1" max="100" value="1" required></label><label>Forma de pagamento<select id="payment"><option value="PIX">Pix</option><option value="CREDIT_CARD">Cartão de crédito</option><option value="BOLETO">Boleto bancário</option></select></label><button class="gradient">Continuar para pagamento</button></form><p class="note">Pagamento real depende das credenciais e da homologação do Mercado Pago.</p>`,
  );
  $("#checkoutForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await api("/orders/checkout", {
        method: "POST",
        body: JSON.stringify({
          items: [{ productId, quantity: Number($("#quantity").value) }],
          paymentMethod: $("#payment").value,
        }),
      });
      if (d.checkoutUrl) {
        location.href = d.checkoutUrl;
      } else {
        showModal(
          `<h2>Pedido criado</h2><p>${esc(d.message)}</p><p>Identificador: ${esc(d.orderId)}</p><button class="gradient" id="done">Voltar à loja</button>`,
        );
        $("#done").onclick = () => {
          closeModal();
          loadProducts();
        };
      }
    } catch (err) {
      toast(err.message);
    }
  };
}
async function logout() {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
  } catch {}
  me = null;
  updateHeader();
  closeModal();
  toast("Você saiu da conta.");
}
updateHeader();
refreshMe().then(loadProducts);
