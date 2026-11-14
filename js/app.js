(function () {
  "use strict";

  // ---------- Data ----------
  // Fictional houses & scents (sample catalogue). price = 2ml price in MNT.
  var PRODUCTS = [
    { id: 1,  house: "Maison Lumen",   name: "Ambre Nocturne",   g: "unisex", notes: "Амбер · Ваниль · Хуш",        price: 38000, color: "#c9974e", tags: ["best", "winter"], rating: 4.9, reviews: 312 },
    { id: 2,  house: "Atelier Noir",   name: "Cedar Royale",     g: "men",    notes: "Хуш мод · Хан боргоцой · Арьс", price: 42000, color: "#3d3550", tags: ["best"], rating: 4.8, reviews: 268 },
    { id: 3,  house: "Rose & Ivory",   name: "Velvet Bloom",     g: "women",  notes: "Сарнай · Пион · Заар",        price: 35000, color: "#d99aa5", tags: ["best", "new"], rating: 4.7, reviews: 190 },
    { id: 4,  house: "Nordique",       name: "Glacier Mint",     g: "men",    notes: "Гаа · Цитрус · Далай",        price: 29000, color: "#7fb3c8", tags: ["sale"], old: 36000, rating: 4.5, reviews: 88 },
    { id: 5,  house: "Maison Lumen",   name: "Oud Sérénade",     g: "unisex", notes: "Уд · Шафран · Сарнай",        price: 52000, color: "#6d3b26", tags: ["best", "winter"], rating: 4.9, reviews: 401 },
    { id: 6,  house: "Petal Society",  name: "Cherry Kiss",      g: "women",  notes: "Интоор · Бүйлс · Тонка",      price: 33000, color: "#a33a4c", tags: ["new", "hot"], rating: 4.6, reviews: 74 },
    { id: 7,  house: "Atelier Noir",   name: "Midnight Leather", g: "men",    notes: "Арьс · Тамхи · Хар перц",     price: 45000, color: "#2a2422", tags: ["winter"], rating: 4.7, reviews: 156 },
    { id: 8,  house: "Solstice",       name: "Neroli Sun",       g: "unisex", notes: "Нероли · Бергамот · Заар",    price: 31000, color: "#f0c25a", tags: ["new"], rating: 4.4, reviews: 41 },
    { id: 9,  house: "Rose & Ivory",   name: "Iris Poudre",      g: "women",  notes: "Цахилдаг · Нунтаг · Заар",    price: 37000, color: "#b7a6cf", tags: ["best"], rating: 4.8, reviews: 222 },
    { id: 10, house: "Nordique",       name: "Pine Ridge",       g: "men",    notes: "Нарс · Ветивер · Гүргэм",     price: 30000, color: "#4f6b4a", tags: ["sale", "winter"], old: 38000, rating: 4.3, reviews: 63 },
    { id: 11, house: "Solstice",       name: "Salt & Fig",       g: "unisex", notes: "Инжир · Далайн давс · Кокос", price: 34000, color: "#8fa58a", tags: ["new"], rating: 4.6, reviews: 37 },
    { id: 12, house: "Petal Society",  name: "Vanilla Cloud",    g: "women",  notes: "Ваниль · Карамель · Заар",    price: 32000, color: "#e8d3b0", tags: ["best", "hot"], rating: 4.9, reviews: 508 },
    { id: 13, house: "Maison Lumen",   name: "Encens Blanc",     g: "unisex", notes: "Хүж · Альдегид · Заар",       price: 47000, color: "#d7d2c8", tags: ["sale"], old: 55000, rating: 4.5, reviews: 92 },
    { id: 14, house: "Atelier Noir",   name: "Bleu Intense",     g: "men",    notes: "Грейпфрут · Хүж · Ветивер",   price: 39000, color: "#2e4a7a", tags: ["best", "new"], rating: 4.8, reviews: 344 },
    { id: 15, house: "Rose & Ivory",   name: "Jasmin Lune",      g: "women",  notes: "Мэлрэг · Тубероз · Амбер",    price: 40000, color: "#f2e6c9", tags: ["winter"], rating: 4.7, reviews: 119 },
    { id: 16, house: "Solstice",       name: "Tabac Doré",       g: "unisex", notes: "Тамхи · Зөгийн бал · Какао",  price: 44000, color: "#8a5a2b", tags: ["winter", "hot"], rating: 4.8, reviews: 201 }
  ];
  var SIZES = [{ ml: 2, k: 1 }, { ml: 5, k: 2.2 }, { ml: 10, k: 4 }];
  var COLLECTIONS = [
    { name: "Өвлийн шилдэг", filter: "winter", a: "#3a2318", b: "#a0623f", c: ["#d9b77a", "#8c4a5b"] },
    { name: "Эмэгтэйчүүдэд", filter: "women", a: "#f3d9dc", b: "#d99aa5", c: ["#f7e6ea", "#a33a4c"] },
    { name: "Эрэгтэйчүүдэд", filter: "men", a: "#d6dde6", b: "#5b6f88", c: ["#2e4a7a", "#3d3550"] },
    { name: "Нишэ унисекс", filter: "unisex", a: "#e4e0d4", b: "#9b8f6f", c: ["#c9974e", "#6d3b26"] },
    { name: "Шинэ бараа", filter: "new", a: "#d8d3e3", b: "#9e93b8", c: ["#b7a6cf", "#f0c25a"] },
    { name: "Хямдрал", filter: "sale", a: "#f1d5cd", b: "#c0392b", c: ["#fff", "#7fb3c8"] },
    { name: "Халуун борлуулалт", filter: "hot", a: "#efe1c6", b: "#d8890b", c: ["#e8d3b0", "#a33a4c"] },
    { name: "Бестселлер", filter: "best", a: "#2b2233", b: "#6b5f70", c: ["#d7d2c8", "#c9974e"] }
  ];
  var BRANDS = ["MAISON LUMEN", "ATELIER NOIR", "ROSE & IVORY", "NORDIQUE", "SOLSTICE", "PETAL SOCIETY", "AURELIA", "KOVAL & SONS"];
  var FREE_SHIP = 100000;

  // ---------- Helpers ----------
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var money = function (n) { return "₮" + Math.round(n).toLocaleString("en-US"); };
  var round100 = function (n) { return Math.round(n / 100) * 100; };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var byId = function (id) { return PRODUCTS.filter(function (p) { return p.id === id; })[0]; };
  var shade = function (hex, amt) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
    var c = function (x) { return Math.max(0, Math.min(255, x)); };
    return "#" + ((1 << 24) + (c(r) << 16) + (c(g) << 8) + c(b)).toString(16).slice(1);
  };

  var uid = 0;
  function bottle(color, h) {
    var id = "g" + (uid++);
    h = h || 200;
    return '<svg viewBox="0 0 80 140" height="' + h + '" aria-hidden="true">' +
      '<defs><linearGradient id="' + id + '" x1="0" x2="1">' +
      '<stop offset="0" stop-color="' + shade(color, 30) + '"/><stop offset=".55" stop-color="' + color + '"/>' +
      '<stop offset="1" stop-color="' + shade(color, -40) + '"/></linearGradient></defs>' +
      '<rect x="30" y="6" width="20" height="18" rx="3" fill="#222"/>' +
      '<rect x="33" y="22" width="14" height="12" fill="#b9a27a"/>' +
      '<rect x="10" y="34" width="60" height="100" rx="10" fill="url(#' + id + ')" stroke="rgba(0,0,0,.15)"/>' +
      '<rect x="16" y="42" width="8" height="80" rx="4" fill="rgba(255,255,255,.35)"/>' +
      '<rect x="22" y="72" width="36" height="26" rx="2" fill="rgba(255,255,255,.85)"/>' +
      '<rect x="27" y="80" width="26" height="2.5" fill="rgba(0,0,0,.55)"/>' +
      '<rect x="31" y="87" width="18" height="1.6" fill="rgba(0,0,0,.35)"/></svg>';
  }

  // ---------- State ----------
  var cart = store.get("gz_cart", []);
  var wish = store.get("gz_wish", []);
  var filter = "best";
  var query = "";

  // ---------- Toast ----------
  var toastT;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("is-show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove("is-show"); }, 2200);
  }

  // ---------- Products ----------
  function matches(p) {
    var f = filter === "all" ? true
      : (filter === "women" || filter === "men" || filter === "unisex") ? p.g === filter
      : p.tags.indexOf(filter) > -1;
    if (!f) return false;
    if (!query) return true;
    var hay = (p.name + " " + p.house + " " + p.notes).toLowerCase();
    return hay.indexOf(query) > -1;
  }

  function card(p) {
    var labels = "";
    if (p.tags.indexOf("new") > -1) labels += '<span class="label label--new">Шинэ</span>';
    if (p.tags.indexOf("hot") > -1) labels += '<span class="label label--hot">Hot</span>';
    if (p.old) labels += '<span class="label label--sale">-' + Math.round((1 - p.price / p.old) * 100) + '%</span>';
    var on = wish.indexOf(p.id) > -1;
    var stars = "★★★★★".slice(0, Math.round(p.rating)) + "☆☆☆☆☆".slice(0, 5 - Math.round(p.rating));
    return '<article class="card" data-id="' + p.id + '" data-size="0">' +
      '<div class="card__media" style="--tint:' + p.color + '33">' + bottle(p.color) +
      '<div class="card__labels">' + labels + '</div>' +
      '<button class="card__wish' + (on ? " is-on" : "") + '" data-wish aria-label="Хүслийн жагсаалтад нэмэх">' +
      '<svg viewBox="0 0 24 24"><path d="M12 20.5 4.6 13.3a4.8 4.8 0 0 1 6.8-6.8l.6.6.6-.6a4.8 4.8 0 0 1 6.8 6.8z"/></svg></button></div>' +
      '<div class="card__body">' +
      '<span class="card__brand">' + p.house + '</span>' +
      '<h3 class="card__title">' + p.name + '</h3>' +
      '<div class="stars">' + stars + '<span>(' + p.reviews + ')</span></div>' +
      '<span class="card__notes">' + p.notes + '</span>' +
      '<div class="card__price" data-price></div>' +
      '<div class="sizes">' + SIZES.map(function (s, i) {
        return '<button data-size="' + i + '"' + (i === 0 ? ' class="is-active"' : "") + '>' + s.ml + 'ml</button>';
      }).join("") + '</div>' +
      '<button class="btn" data-add>Сагсанд нэмэх</button>' +
      '</div></article>';
  }

  function priceFor(p, si) { return round100(p.price * SIZES[si].k); }
  function oldFor(p, si) { return p.old ? round100(p.old * SIZES[si].k) : 0; }

  function updatePrice(el) {
    var p = byId(+el.dataset.id), si = +el.dataset.size;
    var now = priceFor(p, si), old = oldFor(p, si);
    $("[data-price]", el).innerHTML = old
      ? '<span class="sale">' + money(now) + '</span><s>' + money(old) + '</s>'
      : money(now);
  }

  function renderGrid() {
    var list = PRODUCTS.filter(matches);
    var grid = $("#grid");
    grid.innerHTML = list.map(card).join("");
    $$(".card", grid).forEach(function (el, i) { el.style.animationDelay = (i * 0.04) + "s"; updatePrice(el); });
    $("#emptyMsg").hidden = list.length > 0;
    $$("#tabs button").forEach(function (b) { b.classList.toggle("is-active", b.dataset.filter === filter); });
  }

  function setFilter(f) {
    filter = f;
    query = "";
    $("#searchInput").value = "";
    if (!$('#tabs button[data-filter="' + f + '"]')) {
      // filters without a tab (winter, hot) still work, no tab highlighted
    }
    renderGrid();
  }

  $("#grid").addEventListener("click", function (e) {
    var cardEl = e.target.closest(".card");
    if (!cardEl) return;
    var id = +cardEl.dataset.id;
    var sizeBtn = e.target.closest(".sizes button");
    if (sizeBtn) {
      $$(".sizes button", cardEl).forEach(function (b) { b.classList.remove("is-active"); });
      sizeBtn.classList.add("is-active");
      cardEl.dataset.size = sizeBtn.dataset.size;
      updatePrice(cardEl);
      return;
    }
    if (e.target.closest("[data-wish]")) {
      toggleWish(id);
      e.target.closest("[data-wish]").classList.toggle("is-on", wish.indexOf(id) > -1);
      return;
    }
    var add = e.target.closest("[data-add]");
    if (add) {
      addToCart(id, +cardEl.dataset.size);
      add.classList.add("btn--added");
      add.textContent = "✓ Нэмэгдлээ";
      setTimeout(function () { add.classList.remove("btn--added"); add.textContent = "Сагсанд нэмэх"; }, 1400);
    }
  });

  // ---------- Cart ----------
  function saveCart() { store.set("gz_cart", cart); renderCart(); }
  function addToCart(id, si) {
    var line = cart.filter(function (l) { return l.id === id && l.si === si; })[0];
    if (line) line.q++; else cart.push({ id: id, si: si, q: 1 });
    saveCart();
    var p = byId(id);
    toast(p.name + " " + SIZES[si].ml + "ml сагсанд нэмэгдлээ");
  }
  function cartTotal() { return cart.reduce(function (s, l) { return s + priceFor(byId(l.id), l.si) * l.q; }, 0); }

  function renderCart() {
    var count = cart.reduce(function (s, l) { return s + l.q; }, 0);
    var badge = $("#cartCount");
    badge.textContent = count;
    if (count) badge.removeAttribute("data-zero"); else badge.setAttribute("data-zero", "");
    $("#cartHeadCount").textContent = "(" + count + ")";
    var total = cartTotal();
    $("#cartTotal").textContent = money(total);
    var left = FREE_SHIP - total;
    $("#shipMsg").innerHTML = left > 0
      ? "Үнэгүй хүргэлт авахад <b>" + money(left) + "</b> дутуу байна"
      : "🎉 Танд <b>үнэгүй хүргэлт</b> үйлчилнэ!";
    $("#shipFill").style.width = Math.min(100, total / FREE_SHIP * 100) + "%";
    $("#checkoutBtn").disabled = !count;
    var box = $("#cartItems");
    if (!cart.length) { box.innerHTML = '<p class="drawer__empty">Таны сагс хоосон байна.</p>'; return; }
    box.innerHTML = cart.map(function (l, i) {
      var p = byId(l.id);
      return '<div class="line" data-i="' + i + '">' +
        '<div class="line__img" style="--tint:' + p.color + '44">' + bottle(p.color, 46) + '</div>' +
        '<div><div class="line__title">' + p.name + '</div><div class="line__meta">' + p.house + ' · ' + SIZES[l.si].ml + 'ml</div>' +
        '<div class="qty"><button data-q="-1" aria-label="Хасах">−</button><span>' + l.q + '</span><button data-q="1" aria-label="Нэмэх">+</button></div></div>' +
        '<div class="line__right"><b>' + money(priceFor(p, l.si) * l.q) + '</b><button class="line__remove" data-rm>Устгах</button></div></div>';
    }).join("");
  }

  $("#cartItems").addEventListener("click", function (e) {
    var line = e.target.closest(".line");
    if (!line) return;
    var i = +line.dataset.i;
    var q = e.target.closest("[data-q]");
    if (q) { cart[i].q += +q.dataset.q; if (cart[i].q < 1) cart.splice(i, 1); saveCart(); }
    if (e.target.closest("[data-rm]")) { cart.splice(i, 1); saveCart(); }
  });

  $("#checkoutBtn").addEventListener("click", function () {
    toast("Баярлалаа! Захиалга " + money(cartTotal()) + " — төлбөрийн хэсэг удахгүй нэмэгдэнэ.");
  });

  // ---------- Wishlist ----------
  function toggleWish(id) {
    var i = wish.indexOf(id);
    if (i > -1) { wish.splice(i, 1); toast("Хүслийн жагсаалтаас хасагдлаа"); }
    else { wish.push(id); toast("♥ Хүслийн жагсаалтад нэмэгдлээ"); }
    store.set("gz_wish", wish);
    renderWish();
  }
  function renderWish() {
    var badge = $("#wishCount");
    badge.textContent = wish.length;
    if (wish.length) badge.removeAttribute("data-zero"); else badge.setAttribute("data-zero", "");
    var box = $("#wishItems");
    if (!wish.length) { box.innerHTML = '<p class="drawer__empty">Хүслийн жагсаалт хоосон байна.</p>'; return; }
    box.innerHTML = wish.map(function (id) {
      var p = byId(id);
      return '<div class="line" data-id="' + id + '">' +
        '<div class="line__img" style="--tint:' + p.color + '44">' + bottle(p.color, 46) + '</div>' +
        '<div><div class="line__title">' + p.name + '</div><div class="line__meta">' + p.house + ' · ' + money(p.price) + '-аас</div></div>' +
        '<div class="line__right"><button class="btn" data-wadd style="padding:8px 12px;font-size:11px">Сагслах</button>' +
        '<button class="line__remove" data-wrm>Хасах</button></div></div>';
    }).join("");
  }
  $("#wishItems").addEventListener("click", function (e) {
    var line = e.target.closest(".line");
    if (!line) return;
    var id = +line.dataset.id;
    if (e.target.closest("[data-wadd]")) addToCart(id, 0);
    if (e.target.closest("[data-wrm]")) { toggleWish(id); renderGrid(); }
  });

  // ---------- Drawers / menu ----------
  var scrim = $("#scrim");
  function closeAll() {
    $$(".drawer.is-open, .nav.is-open").forEach(function (d) { d.classList.remove("is-open"); });
    scrim.classList.remove("is-open");
    document.body.style.overflow = "";
  }
  function open(id) {
    closeAll();
    $("#" + id).classList.add("is-open");
    scrim.classList.add("is-open");
    document.body.style.overflow = "hidden";
  }
  document.addEventListener("click", function (e) {
    var o = e.target.closest("[data-open]");
    if (o) { e.preventDefault(); open(o.dataset.open); return; }
    if (e.target.closest("[data-close]")) { closeAll(); return; }
    var f = e.target.closest("[data-filter]");
    if (f) {
      setFilter(f.dataset.filter);
      closeAll();
      if (!f.closest("#tabs")) {
        e.preventDefault();
        $("#shop").scrollIntoView({ behavior: "smooth" });
      }
    }
  });
  scrim.addEventListener("click", closeAll);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAll(); });

  $("[data-close-announce]").addEventListener("click", function () {
    $("#announce").classList.add("is-hidden");
    store.set("gz_announce", 1);
  });
  if (store.get("gz_announce", 0)) $("#announce").classList.add("is-hidden");

  // ---------- Search ----------
  var searchT;
  $("#searchInput").addEventListener("input", function (e) {
    clearTimeout(searchT);
    var v = e.target.value.trim().toLowerCase();
    searchT = setTimeout(function () {
      query = v;
      filter = v ? "all" : "best";
      renderGrid();
      if (v) $("#shop").scrollIntoView({ behavior: "smooth" });
    }, 220);
  });

  // ---------- Hero slider ----------
  (function () {
    var slides = $$(".slide");
    var dots = $(".slider__dots");
    var cur = 0, timer;
    slides.forEach(function (s, i) {
      var art = $(".slide__art", s);
      art.innerHTML = art.dataset.bottles.split(",").map(function (c, j) { return bottle(c, [240, 290, 210][j]); }).join("");
      var d = document.createElement("button");
      d.setAttribute("aria-label", "Слайд " + (i + 1));
      d.addEventListener("click", function () { go(i); });
      dots.appendChild(d);
    });
    function go(i) {
      cur = (i + slides.length) % slides.length;
      slides.forEach(function (s, j) { s.classList.toggle("is-active", j === cur); });
      $$("button", dots).forEach(function (d, j) { d.classList.toggle("is-active", j === cur); });
      clearInterval(timer);
      timer = setInterval(function () { go(cur + 1); }, 6000);
    }
    $(".slider__arrow--prev").addEventListener("click", function () { go(cur - 1); });
    $(".slider__arrow--next").addEventListener("click", function () { go(cur + 1); });
    var sx = null;
    $("#slider").addEventListener("touchstart", function (e) { sx = e.touches[0].clientX; }, { passive: true });
    $("#slider").addEventListener("touchend", function (e) {
      if (sx === null) return;
      var dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 40) go(cur + (dx < 0 ? 1 : -1));
      sx = null;
    });
    go(0);
  })();

  // ---------- Collections & brands ----------
  $("#collections").innerHTML = COLLECTIONS.map(function (c) {
    return '<a href="#shop" class="coll" data-filter="' + c.filter + '">' +
      '<div class="coll__art" style="--a:' + c.a + ';--b:' + c.b + '">' + bottle(c.c[0], 120) + bottle(c.c[1], 96) + '</div>' +
      '<span class="coll__name">' + c.name + '</span></a>';
  }).join("");
  var brandHtml = BRANDS.map(function (b) { return "<span>" + b + "</span>"; }).join("");
  $("#brandTrack").innerHTML = brandHtml + brandHtml;

  // ---------- Newsletter ----------
  $("#newsForm").addEventListener("submit", function (e) {
    e.preventDefault();
    e.target.reset();
    toast("Бүртгүүлсэнд баярлалаа!");
  });

  // ---------- Scroll effects ----------
  var header = $("#header"), toTop = $("#toTop");
  window.addEventListener("scroll", function () {
    var y = window.scrollY;
    header.classList.toggle("is-scrolled", y > 10);
    toTop.classList.toggle("is-show", y > 600);
  }, { passive: true });
  toTop.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });

  // ---------- Init ----------
  renderGrid();
  renderCart();
  renderWish();
})();
