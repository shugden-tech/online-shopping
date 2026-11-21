// Mongolian labels for the admin UI (hard-coded on purpose: the admin is owner/staff only, mn).

export const ORDER_STATUS: Record<string, string> = {
  new: "Шинэ",
  confirmed: "Баталгаажсан",
  paid: "Төлөгдсөн",
  shipped: "Хүргэлтэд гарсан",
  done: "Дууссан",
  cancelled: "Цуцлагдсан",
};
/** Button text for moving an order TO a status. */
export const ORDER_ACTION: Record<string, string> = {
  confirmed: "Баталгаажуулах",
  paid: "Төлөгдсөн болгох",
  shipped: "Хүргэлтэд гарсан болгох",
  done: "Дууссан болгох",
  cancelled: "Цуцлах",
};
export const ORDER_PAY_STATUS: Record<string, string> = {
  unpaid: "Төлөгдөөгүй",
  pending: "Төлбөр хүлээгдэж буй",
  paid: "Төлөгдсөн",
  refunded: "Буцаан олгосон",
};
export const PAYMENT_STATUS: Record<string, string> = {
  pending: "Хүлээгдэж буй",
  paid: "Төлөгдсөн",
  failed: "Амжилтгүй",
  expired: "Хугацаа дууссан",
  cancelled: "Цуцлагдсан",
  refunded: "Буцаан олгосон",
};
export const PROVIDER: Record<string, string> = { qpay: "QPay", bank: "Банкны шилжүүлэг", wire: "Wire", manual: "Гараар", mock: "Туршилтын" };
export const SHIPMENT_STATUS: Record<string, string> = {
  pending: "Хүлээгдэж буй",
  created: "Үүссэн",
  picked_up: "Авч явсан",
  in_transit: "Замд яваа",
  delivered: "Хүргэгдсэн",
  failed: "Амжилтгүй",
  cancelled: "Цуцлагдсан",
  returned: "Буцаж ирсэн",
};
export const PRODUCT_STATUS: Record<string, string> = { draft: "Ноорог", active: "Идэвхтэй (харагдана)", hidden: "Нуусан" };
export const GENDER: Record<string, string> = { women: "Эмэгтэй", men: "Эрэгтэй", unisex: "Юнисекс" };
export const SKU_KIND: Record<string, string> = { decant: "Задаргаа (decant)", full: "Бүтэн шил" };
export const STOCK_REASON: Record<string, string> = {
  restock: "Үлдэгдэл нэмсэн",
  correction: "Засвар",
  sale: "Борлуулалт",
  cancel_after_paid: "Төлөгдсөний дараа цуцалсан",
  import: "Импортлосон",
};
export const ENTITY: Record<string, string> = {
  product: "Бараа", sku: "Хэмжээ (SKU)", order: "Захиалга", payment: "Төлбөр", shipment: "Хүргэлт", settings: "Тохиргоо", media: "Зураг", webhook: "Webhook", bundle: "Багц", customer: "Хэрэглэгч",
};
export const ACTOR: Record<string, string> = { "admin:owner": "Эзэмшигч", "admin:staff": "Ажилтан", system: "Систем", customer: "Хэрэглэгч" };
/** Readable names for audit actions. Unknown ones are shown as-is. */
export const ACTION: Record<string, string> = {
  "customer.reset_password": "Хэрэглэгчийн нууц үг сэргээсэн",
  "product.create": "Бараа үүсгэсэн", "product.update": "Бараа зассан", "sku.create": "Хэмжээ нэмсэн", "sku.update": "Үнэ / хэмжээ зассан",
  "sku.delete": "Хэмжээ устгасан", "inventory.adjust": "Үлдэгдэл тохируулсан", "media.upload": "Зураг оруулсан",
  "order.create": "Захиалга үүссэн", "order.status": "Захиалгын төлөв", "order.paid": "Төлбөр баталгаажсан", "order.note": "Тэмдэглэл нэмсэн",
  "payment.late": "Хоцорсон төлбөр", "payment.extra": "Илүү төлбөр", "shipment.create": "Хүргэлт үүсгэсэн", "shipment.status": "Хүргэлтийн төлөв",
  "shipment.update": "Хяналтын дугаар зассан", "shipment.details": "Хүргэлтийн мэдээлэл", "settings.update": "Тохиргоо өөрчилсөн", "jobs.run": "Автомат ажил",
  "webhook.create": "Webhook нэмсэн", "webhook.update": "Webhook зассан", "webhook.delete": "Webhook устгасан", "webhook.test": "Туршилтын webhook",
  "bundle.create": "Багц үүсгэсэн", "bundle.update": "Багц зассан", "bundle.delete": "Багц устгасан",
  "webhook.redeliver": "Webhook дахин илгээсэн", "webhook.replay": "Webhook дахин боловсруулсан",
};
export const ROLE: Record<string, string> = { owner: "Эзэмшигч", staff: "Ажилтан" };

const CODES: Record<string, string> = {
  unauthorized: "токен буруу эсвэл хугацаа дууссан",
  forbidden: "эрх хүрэлцэхгүй",
  rate: "хэт олон оролдлого, түр хүлээгээд дахин оролдоно уу",
  "admin-disabled": "админ хэсэг идэвхгүй (серверт ADMIN_TOKEN тохируулаагүй)",
  server: "серверийн алдаа",
  notFound: "олдсонгүй",
  invalid: "буруу утга",
  unknown: "үл мэдэгдэх талбар",
  required: "заавал бөглөх ёстой",
  exists: "аль хэдийн байна",
  duplicate: "давхардсан",
  conflict: "зөрчил үүслээ",
  transition: "энэ төлөвт шилжүүлэх боломжгүй",
  stock: "үлдэгдэл хүрэлцэхгүй",
  unavailable: "зарагдах боломжгүй",
  closed: "захиалга хаалттай",
  disabled: "унтраасан",
  reserved: "захиалгад нөөцлөгдсөн",
  method: "энэ үйлдэл зөвшөөрөгдөөгүй",
  type: "файлын төрөл буруу (jpeg/png/webp)",
  size: "файл хэт том (≤ 5 MB)",
  too_large: "файл хэт том (≤ 5 MB)",
  below_reserved: "нөөцлөгдсөн тооноос бага болгох боломжгүй",
  not_paid: "захиалга төлөгдөөгүй байна",
  untracked: "үлдэгдэл тоолдоггүй хэмжээ — эхлээд “Тоог тогтоох (=)”-оор тоо оруулна уу",
  compare_at: "хуучин үнэ одоогийн үнээс их байх ёстой",
  not_above_price: "хуучин үнэ одоогийн үнээс их байх ёстой",
  taken: "ийм ID аль хэдийн бүртгэлтэй",
  not_found: "олдсонгүй",
  "media-disabled": "зургийн сан (R2) тохируулаагүй",
  "has-shipment": "энэ захиалгад хүргэлт аль хэдийн үүссэн",
  "not-paid": "захиалга төлөгдөөгүй",
  "not-configured": "тохируулаагүй",
  "not-qpay": "QPay төлбөр биш",
  unreachable: "холбогдож чадсангүй",
  unsigned: "гарын үсэг баталгаажаагүй дуудлагыг дахин боловсруулахгүй",
  limit: "хязгаарт хүрсэн",
  empty: "өөрчлөлт алга",
  stale: "өөр газар өөрчлөгдсөн, хуудсаа шинэчлээд дахин оролдоно уу",
  "use-retry": "“Дахин оролдох” товчийг ашиглана уу",
}
const FIELDS: Record<string, string> = {
  form: "", stock: "Үлдэгдэл", status: "Төлөв", price: "Үнэ", compareAt: "Хуучин үнэ", kind: "Төрөл", ml: "мл", active: "Идэвхтэй",
  sku: "SKU", set: "Тоо", delta: "Өөрчлөлт", reason: "Шалтгаан", note: "Тэмдэглэл", amount: "Дүн", reference: "Гүйлгээний утга",
  id: "ID", brand: "Брэнд", name: "Нэр", file: "Файл", side: "Тал", imageFront: "Урд зураг", imageBack: "Ар зураг",
  trackingNo: "Хяналтын дугаар", trackingUrl: "Хяналтын холбоос", orderNo: "Захиалгын дугаар", entity: "Төрөл", payment: "Төлбөр",
  releaseYear: "Гарсан он", gender: "Хүйс", concentration: "Концентраци", family: "Үнэрийн бүл",
  courier: "Хүргэгч", fee: "Зардал", notes: "Тэмдэглэл", url: "Хаяг (URL)", events: "Үйл явдал", ids: "Бараа", action: "Үйлдэл",
  productId: "Бараа", provider: "Үйлчилгээ", shipment: "Хүргэлт", signature: "Гарын үсэг", description: "Тайлбар",
};

/** `{ ok:false, errors }` -> one readable Mongolian sentence. */
export function errorText(status: number, errors: Record<string, string> | undefined, conflict?: string): string {
  if (status === 403) return "Эрх хүрэлцэхгүй: энэ үйлдлийг хийх эрх танд алга.";
  const parts = Object.entries(errors ?? {}).map(([field, code]) => {
    const f = FIELDS[field] ?? field;
    const c = CODES[code] ?? code;
    return f ? `${f}: ${c}` : c;
  });
  const codes = parts.length ? parts.join("; ") : "";
  if (status === 409) return `Зөрчил (409): ${conflict ?? "өгөгдөл өөрчлөгдсөн байна, хуудсаа шинэчилнэ үү."}${codes ? ` [${codes}]` : ""}`;
  if (status === 404) return `Олдсонгүй (404).${codes ? ` ${codes}` : ""}`;
  if (status === 429) return "Хэт олон хүсэлт. Түр хүлээгээд дахин оролдоно уу.";
  if (status >= 500) return `Серверийн алдаа (${status}).${codes ? ` ${codes}` : ""}`;
  return `Алдаа (${status || "сүлжээ"}): ${codes || "тодорхойгүй алдаа"}`;
}

const nf = new Intl.NumberFormat("en-US");
export const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${nf.format(n)}₮`);
export const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : nf.format(n));
/** D1 times are UTC 'YYYY-MM-DD HH:MM:SS'; show them in local time. */
export function when(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return s;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
