-- 0005: bundles (багц). A bundle is sold as one cart line at its own price; ordering it reserves the stock of
-- every part SKU (bundle_items) in the same D1 batch as any other order line. Contract: docs/CONTRACTS.md §9.
--
-- Money is INTEGER MNT (₮). A bundle with price NULL is not for sale. Parts are SKU ids '<product_id>:<ml>'
-- with no foreign key, so a bundle can name a size the owner has not created yet (it then shows as unavailable).

CREATE TABLE bundles (
  id TEXT PRIMARY KEY,                        -- URL slug, e.g. 'fresh-citrus' (never renamed)
  name_mn TEXT NOT NULL,
  name_en TEXT,
  description_mn TEXT,
  description_en TEXT,
  image TEXT,                                 -- https URL (R2 public host) or site path '/bundles/1.webp'
  price INTEGER CHECK (price IS NULL OR price > 0),
  compare_at INTEGER CHECK (compare_at IS NULL OR compare_at > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','hidden')),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bundles_status ON bundles(status, sort, id);

CREATE TABLE bundle_items (
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,                          -- '<product_id>:<ml>'
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 10),
  label TEXT,                                 -- shown when the product is not in the catalog yet
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bundle_id, sku)
);
CREATE INDEX idx_bundle_items_sku ON bundle_items(sku);

-- The owner's eight bundles (previously src/data/bundles.ts): 3 × 10 ml, 99,000₮ each.
INSERT INTO bundles (id, name_mn, name_en, description_mn, description_en, image, price, status, sort) VALUES
 ('day-to-evening', 'Өдөр, оройн гурвал', 'Day to Evening',
  'Бергамот, цитрус, лавандын цэнгэг үнэр дээр Stronger With You Intensely-ийн амтлаг амбр нэмэгдсэн гурвал. Өдөр ч, орой ч тохирно.',
  'Bergamot, citrus and lavender, with the sweet amber of Stronger With You Intensely. Works for day and evening.',
  '/bundles/1.webp', 99000, 'active', 1),
 ('warm-spice-wood', 'Дулаан амтлагч', 'Warm Spice and Wood',
  'Ваниль, тонка, амбр, модлог суурьтай гурван үнэр. Гаа, чинжүү, шанцайны өнгө нь сэрүүн улиралд илүү тохирно.',
  'Three scents on a base of vanilla, tonka, amber and woods, with touches of mint, pepper and cinnamon. Best in the cooler months.',
  '/bundles/2.webp', 99000, 'active', 2),
 ('fresh-citrus', 'Цитрусын сэрүүн', 'Fresh Citrus',
  'Нимбэг, бергамот, грейпфрут, мандарины цэнгэг гурвал. Хөнгөн, цэвэрхэн тул зуны өдөр, ажлын цагт тохиромжтой.',
  'A bright trio of lemon, bergamot, grapefruit and mandarin. Light and clean, for summer days and the office.',
  '/bundles/3.webp', 99000, 'active', 3),
 ('wood-and-lavender', 'Мод ба лаванда', 'Wood and Lavender',
  'Montblanc Legend, Le Male-ийн лаванда, бергамот дээр Born in Roma-гийн давслаг, ветивертэй модлог үнэр нэмэгдсэн. Тайван, эрэлхэг сонголт.',
  'The lavender and bergamot of Montblanc Legend and Le Male, with the salty, vetiver-woody Born in Roma. A calm, confident set.',
  '/bundles/4.webp', 99000, 'active', 4),
 ('evening-warmth', 'Оройн дулаан', 'Evening Warmth',
  'Ваниль, амбр, хуш, зандан модны гүн үнэртэй гурвал. Грейпфрут, мандарин, чинжүү эхэндээ сэргэг өнгө өгнө. Оройд тохирно.',
  'A deeper trio of vanilla, amber, cedar and sandalwood, opened by grapefruit, mandarin and pepper. Made for evenings.',
  '/bundles/5.webp', 99000, 'active', 5),
 ('tobacco-and-sea', 'Тамхи ба далай', 'Tobacco and Sea',
  'Dolce & Gabbana-гийн тамхи, тонка, хуш, Invictus-ийн далайн сэрүүн үнэр, Armani-гийн амтлаг амбр нэг дор. Олон өнгөтэй гурвал.',
  'The tobacco, tonka and cedar of Dolce & Gabbana, the marine freshness of Invictus and the sweet amber of Armani. A varied trio.',
  '/bundles/6.webp', 99000, 'active', 6),
 ('fresh-ginger-wood', 'Сэргэг модлог', 'Fresh Ginger Wood',
  'Бергамот, алим, цагаан гаа, лаванда, хуш модтой сэргэг гурвал. Ажлын өдөр, өдрийн уулзалтад тохиромжтой.',
  'A fresh, woody trio of bergamot, apple, ginger, lavender and cedar. Good for workdays and daytime meetings.',
  '/bundles/7.webp', 99000, 'active', 7),
 ('sweet-tobacco-night', 'Амтлаг шөнө', 'Sweet Tobacco Night',
  'Зөгийн бал, ваниль, тамхи, тонкатай амтлаг гурвал. Гаа, лаванда, цитрус эхэндээ сэрүүн өнгө өгнө. Орой, хүйтэн өдөрт тохирно.',
  'A sweet trio of honey, vanilla, tobacco and tonka, opened by mint, lavender and citrus. For evenings and cold days.',
  '/bundles/8.webp', 99000, 'active', 8);

-- Parts (10 ml each). Labels are the owner's names, used while a product is not in the catalog.
INSERT INTO bundle_items (bundle_id, sku, qty, label, sort) VALUES
 ('day-to-evening', 'montblanc-legend-edt:10', 1, 'Montblanc Legend EDT', 1),
 ('day-to-evening', 'emporio-armani-stronger-with-you-intensely-edp:10', 1, 'Emporio Armani Stronger With You Intensely EDP', 2),
 ('day-to-evening', 'versace-pour-homme-edt:10', 1, 'Versace Pour Homme EDT', 3),
 ('warm-spice-wood', 'jean-paul-gaultier-le-male-edt:10', 1, 'Jean Paul Gaultier Le Male EDT', 1),
 ('warm-spice-wood', 'hermes-terre-dhermes-edt:10', 1, 'Terre d''Hermès EDT', 2),
 ('warm-spice-wood', 'versace-eros-edt:10', 1, 'Versace Eros EDT', 3),
 ('fresh-citrus', 'versace-pour-homme-edt:10', 1, 'Versace Pour Homme EDT', 1),
 ('fresh-citrus', 'dolce-gabbana-light-blue-pour-homme-edt:10', 1, 'Dolce & Gabbana Light Blue Pour Homme EDT', 2),
 ('fresh-citrus', 'maison-margiela-replica-sailing-day-edt:10', 1, 'Maison Margiela Replica Sailing Day EDT', 3),
 ('wood-and-lavender', 'montblanc-legend-edt:10', 1, 'Montblanc Legend EDT', 1),
 ('wood-and-lavender', 'valentino-uomo-born-in-roma-edt:10', 1, 'Valentino Uomo Born In Roma EDT', 2),
 ('wood-and-lavender', 'jean-paul-gaultier-le-male-edt:10', 1, 'Jean Paul Gaultier Le Male EDT', 3),
 ('evening-warmth', 'versace-eros-parfum:10', 1, 'Versace Eros Parfum', 1),
 ('evening-warmth', 'azzaro-the-most-wanted-parfum:10', 1, 'Azzaro The Most Wanted Parfum', 2),
 ('evening-warmth', 'hermes-terre-dhermes-edt:10', 1, 'Terre d''Hermès EDT', 3),
 ('tobacco-and-sea', 'dolce-gabbana-pour-homme-edt:10', 1, 'Dolce & Gabbana Pour Homme EDT', 1),
 ('tobacco-and-sea', 'paco-rabanne-invictus-edt:10', 1, 'Rabanne Invictus EDT', 2),
 ('tobacco-and-sea', 'emporio-armani-stronger-with-you-intensely-edp:10', 1, 'Emporio Armani Stronger With You Intensely EDP', 3),
 ('fresh-ginger-wood', 'montblanc-legend-edt:10', 1, 'Montblanc Legend EDT', 1),
 ('fresh-ginger-wood', 'yves-saint-laurent-y-edp:10', 1, 'Yves Saint Laurent Y EDP', 2),
 ('fresh-ginger-wood', 'moncler-pour-homme-edp:10', 1, 'Moncler Pour Homme EDP', 3),
 ('sweet-tobacco-night', 'versace-eros-edp:10', 1, 'Versace Eros EDP', 1),
 ('sweet-tobacco-night', 'jean-paul-gaultier-le-male-elixir-parfum:10', 1, 'Jean Paul Gaultier Le Male Elixir Parfum', 2),
 ('sweet-tobacco-night', 'dolce-gabbana-pour-homme-edt:10', 1, 'Dolce & Gabbana Pour Homme EDT', 3);
