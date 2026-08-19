/**
 * Hardsmile kalkulačka – backend (Google Apps Script)
 *
 * 1) Sdílené úložiště úprav (fixní náklady, hodiny) – GET vrací STATE, POST ukládá.
 * 2) Živý obrat ze Shoptetu – GET ?orders=1 stáhne export objednávek, sečte po měsících
 *    (NEW / MO / VO podle typu zákazníka) a vrátí JSON. Výsledek se cachuje na 1 hodinu.
 *
 * Nasazení: Nasadit → Správa nasazení → tužka → Verze: Nová verze → Deploy
 * (přístup musí zůstat „Anyone", URL zůstane stejná).
 */

var SHOPTET_ORDERS_URL = "https://www.hardsmile.cz/export/orders.csv?patternId=7&partnerId=4&hash=7fd706778b979c489111fa4b1ea743e3d84f5cf29ca480b4bbf847864683b7ba";
// Seznam e-mailů STÁVAJÍCÍCH zákazníků (MO). Kdo tu není = nový zákazník (NEW).
var SEZNAM_URL = "https://docs.google.com/spreadsheets/d/1eSX2KjOZNcVR1hK1UF3taR-HY-HxzwD8WHSYhysGCOc/gviz/tq?tqx=out:csv&sheet=seznam";

function doGet(e) {
  var p = (e && e.parameter) || {};
  var body;
  if (p.orders) {
    body = getOrdersAgg();
  } else if (p.customers) {
    body = JSON.stringify(computeCustomers());
  } else if (p.products) {
    body = getProductsAgg();
  } else if (p.geo) {
    body = getGeoAgg();
  } else {
    body = PropertiesService.getScriptProperties().getProperty("STATE") || "{}";
  }
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + "(" + body + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var body = (e && e.postData && e.postData.contents) || "{}";
    var incoming = JSON.parse(body);
    // MERGE (ne přepis) + prázdný/nevalidní POST STATE NEmaže → ochrana proti vymazání sdíleného stavu.
    if (incoming && typeof incoming === "object" && !(incoming instanceof Array) && Object.keys(incoming).length) {
      var props = PropertiesService.getScriptProperties();
      var cur = {};
      try { cur = JSON.parse(props.getProperty("STATE") || "{}"); } catch (pe) { cur = {}; }
      Object.keys(incoming).forEach(function (k) { cur[k] = incoming[k]; });
      props.setProperty("STATE", JSON.stringify(cur));
    }
    // Ruční VO seznam se mohl změnit → zneplatni cache agregace, ať se hned projeví.
    try { CacheService.getScriptCache().remove("ORDERS_AGG"); } catch (ce) {}
    try { CacheService.getScriptCache().remove("PRODUCTS_AGG"); } catch (ce2) {}
    try { CacheService.getScriptCache().remove("GEO_AGG"); } catch (ce3) {}
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Vrátí (cachovaný) agregovaný obrat po měsících.
function getOrdersAgg() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("ORDERS_AGG");
  if (cached) return cached;
  var json = JSON.stringify(computeOrdersAgg());
  try { cache.put("ORDERS_AGG", json, 3600); } catch (e) {}
  return json;
}

// ===== Prodeje produktů po měsících =====
function getProductsAgg() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("PRODUCTS_AGG");
  if (cached) return cached;
  var json = JSON.stringify(computeProductsAgg());
  try { cache.put("PRODUCTS_AGG", json, 3600); } catch (e) {}
  return json;
}
// ===== Země & měny =====
// Detekce země z textu dopravy (Shoptet píše u zahraničních objednávek zemi do názvu dopravy).
function detectCountry(shipText) {
  var t = String(shipText || "");
  if (/\bSK\b/.test(t) || /slovensk/i.test(t)) return "SK";
  if (/\bPL\b/.test(t) || /polsk|poland/i.test(t)) return "PL";
  if (/\bDE\b/.test(t) || /německo|germany|deutschland/i.test(t)) return "DE";
  if (/\bAT\b/.test(t) || /rakous|austria/i.test(t)) return "AT";
  if (/\bHU\b/.test(t) || /maďar|hungary/i.test(t)) return "HU";
  return null; // neurčeno → bereme jako CZ
}
// Měna podle země (hlavní e-shop je CZ/CZK, zahraniční objednávky jsou v EUR).
function currencyForCountry(cc) { return cc === "CZ" ? "CZK" : "EUR"; }
function countryName(cc) {
  return ({ CZ: "Česko", SK: "Slovensko", PL: "Polsko", DE: "Německo", AT: "Rakousko", HU: "Maďarsko" })[cc] || cc;
}
// Agregace objednávek podle země a měny (obrat je v nativní měně objednávky).
function computeGeoAgg() {
  var text = UrlFetchApp.fetch(SHOPTET_ORDERS_URL, { muteHttpExceptions: true }).getContentText("windows-1250");
  var rows = parseCsvAll(text);
  if (!rows.length) return {};
  var header = rows[0].map(function (h) { return h.trim(); });
  var col = {};
  header.forEach(function (h, i) { col[h] = i; });
  var idc = col["id"], datec = col["date"], statusc = col["statusName"], emailc = col["email"], pricec = col["totalPriceWithoutVat"], typec = col["orderItemType"], namec = col["orderItemName"];
  var byId = {};
  for (var i = 1; i < rows.length; i++) {
    var f = rows[i];
    var id = f[idc];
    if (!id) continue;
    if (!byId[id]) {
      var status = f[statusc] || "";
      byId[id] = {
        date: f[datec] || "", email: (f[emailc] || "").toLowerCase(), price: num(f[pricec]),
        storno: /storn|zrušen|vrácen|refund/i.test(status), country: null
      };
    }
    if (typec != null && f[typec] === "shipping") {
      var c = detectCountry(f[namec] || "");
      if (c) byId[id].country = c;
    }
  }
  var agg = {};
  Object.keys(byId).forEach(function (id) {
    var o = byId[id];
    if (o.storno || o.date.length < 7) return;
    var cc = o.country || "CZ";
    if (!agg[cc]) agg[cc] = { country: cc, name: countryName(cc), currency: currencyForCountry(cc), orders: 0, revenue: 0, emails: {}, months: {} };
    var a = agg[cc];
    a.orders++;
    a.revenue += o.price;
    if (o.email) a.emails[o.email] = 1;
    var ym = o.date.substring(0, 7);
    if (!a.months[ym]) a.months[ym] = { orders: 0, revenue: 0 };
    a.months[ym].orders++;
    a.months[ym].revenue += o.price;
  });
  var out = {};
  Object.keys(agg).forEach(function (cc) {
    var a = agg[cc];
    var cust = Object.keys(a.emails).length;
    out[cc] = {
      country: cc, name: a.name, currency: a.currency,
      orders: a.orders, revenue: Math.round(a.revenue * 100) / 100, customers: cust,
      aov: a.orders ? Math.round(a.revenue / a.orders * 100) / 100 : 0,
      ordersPerCustomer: cust ? Math.round(a.orders / cust * 100) / 100 : 0,
      months: a.months
    };
  });
  return out;
}
function getGeoAgg() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("GEO_AGG");
  if (cached) return cached;
  var json = JSON.stringify(computeGeoAgg());
  try { cache.put("GEO_AGG", json, 3600); } catch (e) {}
  return json;
}
// Zařazení produktu podle názvu. null = vynechat (tip pro skladníka, členství).
function classifyProductGroup(n) {
  if (/kostk/i.test(n)) return "Kostky";
  if (/gel/i.test(n)) return "Gel";
  if (/olej/i.test(n)) return "Olej";
  if (/5\s*\+\s*1/.test(n)) return "5+1 ZDARMA";
  if (/3\s*x/i.test(n)) return "3x VÁŠEŇ";
  if (/XXL/i.test(n)) return "Balení XXL";
  if (/single|pyl[tť]/i.test(n)) return "Single/pyltíček";
  if (/skladn|[čc]lenstv|member|p[řr]edplatn/i.test(n)) return null;
  return "Ostatní";
}
// Počet dávek na kus (z názvu, např. "6 dávek"). Když text "N dávek" chybí,
// odvodí se z typu balení (staré varianty mají v názvu jen kód).
function doseCount(n) {
  var m = String(n).match(/(\d+)\s*d[áa]v/i);
  if (m) return parseInt(m[1], 10);
  if (/XXL/i.test(n)) return 20;      // Balení XXL = 20 dávek
  if (/5\s*\+\s*1/.test(n)) return 6; // 5+1 ZDARMA = 6 dávek
  if (/3\s*x/i.test(n)) return 3;     // 3x VÁŠEŇ = 3 dávky
  if (/single|pyl[tť]/i.test(n)) return 1;
  return 1;
}
// Příchuť z názvu (zatím Citrónová vs základní "12 bylin v medu").
function productFlavor(n) {
  return /citr/i.test(n) ? "Citrónová" : "12 bylin v medu";
}
// Stáhne položky objednávek (řádky typu product), bez dedup, bez storn.
function fetchOrderItems() {
  var text = UrlFetchApp.fetch(SHOPTET_ORDERS_URL, { muteHttpExceptions: true }).getContentText("windows-1250");
  var rows = parseCsvAll(text);
  if (!rows.length) return [];
  var header = rows[0].map(function (h) { return h.trim(); });
  var col = {};
  header.forEach(function (h, i) { col[h] = i; });
  function findCol(re, fallback) {
    if (col[fallback] != null) return col[fallback];
    var idx = -1;
    Object.keys(col).forEach(function (h) { if (re.test(h)) idx = col[h]; });
    return idx;
  }
  var cDate = col["date"], cStatus = col["statusName"], cType = col["orderItemType"];
  var cName = findCol(/n[áa]zev|item.*name|polo[žz]k/i, "orderItemName");
  var cAmt = findCol(/po[čc]et|mno[žz]stv|amount|qty/i, "orderItemAmount");
  var items = [];
  for (var i = 1; i < rows.length; i++) {
    var f = rows[i];
    if ((f[cType] || "") !== "product") continue;
    var st = f[cStatus] || "";
    if (/storn|zrušen|vrácen|refund/i.test(st)) continue;
    var date = f[cDate] || "";
    if (date.length < 7) continue;
    var amt = num(cAmt >= 0 ? f[cAmt] : "1");
    if (!(amt > 0)) amt = 1;
    items.push({ ym: date.substring(0, 7), name: (cName >= 0 ? f[cName] : "") || "", amt: amt });
  }
  return items;
}
// Agregace prodejů po měsících: products (ks), flavors (dávky), standalone (ks).
function computeProductsAgg() {
  var items = fetchOrderItems();
  var agg = {};
  items.forEach(function (it) {
    if (!agg[it.ym]) agg[it.ym] = { products: {}, flavors: {}, standalone: {} };
    var a = agg[it.ym];
    var g = classifyProductGroup(it.name);
    if (!g) return;
    a.products[g] = (a.products[g] || 0) + it.amt;
    if (g === "Kostky" || g === "Gel" || g === "Olej") {
      a.standalone[g] = (a.standalone[g] || 0) + it.amt;
    } else if (g !== "Ostatní") {
      var fl = productFlavor(it.name);
      a.flavors[fl] = (a.flavors[fl] || 0) + it.amt * doseCount(it.name);
    }
  });
  return agg;
}

function parseCsvLine(line) {
  // Shoptet export používá oddělovač ; a hodnoty v uvozovkách
  var out = [], cur = "", inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (ch === ';' && !inQ) { out.push(cur); cur = ""; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

function num(s) {
  return parseFloat(String(s).replace(/\s/g, "").replace(",", ".")) || 0;
}

// Načte seznam e-mailů stávajících zákazníků (množina, malými písmeny).
function loadSeznam() {
  var set = {};
  try {
    var resp = UrlFetchApp.fetch(SEZNAM_URL, { muteHttpExceptions: true });
    var lines = resp.getContentText("UTF-8").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var e = lines[i].replace(/^"|"$/g, "").trim().toLowerCase();
      if (e && e !== "email") set[e] = true;
    }
  } catch (err) {}
  return set;
}

// Ruční seznam VO e-mailů uložený v STATE (přidané přes chráněný panel v aplikaci).
function loadManualVO() {
  var set = {};
  try {
    var state = JSON.parse(PropertiesService.getScriptProperties().getProperty("STATE") || "{}");
    (state.voEmails || []).forEach(function (e) { set[String(e).trim().toLowerCase()] = true; });
  } catch (e) {}
  return set;
}

// Ruční přepis klasifikace per e-mail: { "email": "NEW"|"MO"|"VO" } uložený v STATE.
function loadClassOverride() {
  var m = {};
  try {
    var state = JSON.parse(PropertiesService.getScriptProperties().getProperty("STATE") || "{}");
    var co = state.classOverride || {};
    Object.keys(co).forEach(function (k) { m[String(k).trim().toLowerCase()] = co[k]; });
  } catch (e) {}
  return m;
}

// Rozparsuje celý CSV (oddělovač ;) na řádky-pole. Správně zvládá uvozovky a
// VÍCEŘÁDKOVÉ hodnoty (poznámka přes více řádků nerozbije záznam).
function parseCsvAll(text) {
  var rows = [], row = [], cur = "", inQ = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ';') { row.push(cur); cur = ""; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (ch === '\r') { /* přeskoč */ }
      else { cur += ch; }
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Stáhne export a vrátí 1 řádek na objednávku (deduplikováno podle id).
function fetchOrders() {
  var text = UrlFetchApp.fetch(SHOPTET_ORDERS_URL, { muteHttpExceptions: true }).getContentText("windows-1250");
  var rows = parseCsvAll(text);
  if (!rows.length) return [];
  var header = rows[0].map(function (h) { return h.trim(); });
  var col = {};
  header.forEach(function (h, i) { col[h] = i; });
  // Sloupec s poznámkou (zdroj Repetiv se propisuje do poznámky e-shopu, např. "shopRemark").
  var noteCol = -1;
  Object.keys(col).forEach(function (h) { if (/pozn|note|remark/i.test(h) && !/item|polo/i.test(h)) noteCol = col[h]; });
  var seenId = {}, orders = [];
  for (var i = 1; i < rows.length; i++) {
    var f = rows[i];
    var id = f[col["id"]];
    if (!id || seenId[id]) continue;
    var status = f[col["statusName"]] || "";
    // Nezapočítávat storna / zrušené / vrácené objednávky.
    if (/storn|zrušen|vrácen|refund/i.test(status)) { seenId[id] = true; continue; }
    seenId[id] = true;
    orders.push({
      id: id,
      status: status,
      date: f[col["date"]] || "",
      email: (f[col["email"]] || "").toLowerCase(),
      grpType: f[col["customerGroupType"]] || "",
      grpName: f[col["customerGroupName"]] || "",
      price: num(f[col["totalPriceWithoutVat"]]),
      note: (noteCol >= 0 ? (f[noteCol] || "") : "")
    });
  }
  return orders;
}

// Ruční přepis skupiny per e-mail: { "email": "VIP" | "VO 35" | "Koncový zákazník" | ... }
function loadGroupOverride() {
  var m = {};
  try {
    var state = JSON.parse(PropertiesService.getScriptProperties().getProperty("STATE") || "{}");
    var go = state.groupOverride || {};
    Object.keys(go).forEach(function (k) { m[String(k).trim().toLowerCase()] = go[k]; });
  } catch (e) {}
  return m;
}

// Vrátí platnou skupinu zákazníka (ruční přepis má přednost před skupinou ze Shoptetu).
function effectiveGroup(email, grpName, ctx) {
  return (ctx.groupOverride[email] != null) ? ctx.groupOverride[email] : (grpName || "");
}

// Je skupina velkoobchodní (VO / Velkoobchod / VIP)?
function isVoGroup(g) {
  return /^VO/i.test(g) || /elkoobchod/i.test(g) || /VIP/i.test(g);
}

// Zařadí objednávku/zákazníka do NEW/MO/VO. Priorita: ruční třída → stav VIP → skupina VO(vč. VIP) → seznam(MO) → NEW.
function classify(email, grpType, grpName, ctx, status) {
  var ov = ctx.classOverride[email];
  if (ov === "NEW" || ov === "MO" || ov === "VO") return ov;
  // Stav objednávky "VIP-Datbáze" (velkoobchodní/databázová objednávka) = VO.
  if (status && /VIP/i.test(status)) return "VO";
  var hasGroupOv = ctx.groupOverride[email] != null;
  var g = effectiveGroup(email, grpName, ctx);
  // grpType ze Shoptetu bereme jen když skupina není ručně přepsaná
  var typeVO = !hasGroupOv && grpType === "customerGroupTypeWholesale";
  if (typeVO || isVoGroup(g) || ctx.voManual[email]) return "VO";
  if (ctx.seznam[email]) return "MO";
  return "NEW";
}

function loadClassCtx() {
  return { seznam: loadSeznam(), voManual: loadManualVO(), classOverride: loadClassOverride(), groupOverride: loadGroupOverride() };
}

function computeOrdersAgg() {
  var ctx = loadClassCtx();
  var orders = fetchOrders();
  var agg = {};
  orders.forEach(function (o) {
    if (o.date.length < 7) return;
    var ym = o.date.substring(0, 7);
    if (!agg[ym]) agg[ym] = { rev_new: 0, rev_mo: 0, rev_vo: 0, rev_vip: 0, cnt_new: 0, cnt_mo: 0, cnt_vo: 0, cnt_vip: 0, rev_rep: 0, cnt_rep: 0 };
    var cls = classify(o.email, o.grpType, o.grpName, ctx, o.status);
    if (cls === "VO") { agg[ym].rev_vo += o.price; agg[ym].cnt_vo++; }
    else if (cls === "MO") { agg[ym].rev_mo += o.price; agg[ym].cnt_mo++; }
    else { agg[ym].rev_new += o.price; agg[ym].cnt_new++; }
    // VIP = podmnožina VO: stav objednávky "VIP-Datbáze" NEBO zákaznická skupina VIP (vč. ručního přepisu).
    var gEff = effectiveGroup(o.email, o.grpName, ctx);
    if (/VIP/i.test(o.status || "") || /VIP/i.test(gEff)) { agg[ym].rev_vip += o.price; agg[ym].cnt_vip++; }
    // Repetiv (podle poznámky) – jen informativní rozpad, objednávky zůstávají ve své třídě (typicky NEW).
    if (/repetiv/i.test(o.note)) { agg[ym].rev_rep += o.price; agg[ym].cnt_rep++; }
  });
  return agg;
}

// Agregace po zákaznících pro tabulku: e-mail, počet objednávek, obrat, poslední objednávka, skupina, klasifikace.
function computeCustomers() {
  var ctx = loadClassCtx();
  var orders = fetchOrders();
  var byEmail = {};
  orders.forEach(function (o) {
    if (!o.email) return;
    if (!byEmail[o.email]) byEmail[o.email] = { email: o.email, orders: 0, revenue: 0, lastDate: "", grpName: o.grpName, grpType: o.grpType, vip: false };
    var c = byEmail[o.email];
    c.orders++;
    c.revenue += o.price;
    if (/VIP/i.test(o.status || "")) c.vip = true;
    if (o.date > c.lastDate) { c.lastDate = o.date; c.grpName = o.grpName; c.grpType = o.grpType; }
  });
  return Object.keys(byEmail).map(function (e) {
    var c = byEmail[e];
    return {
      email: c.email,
      orders: c.orders,
      revenue: Math.round(c.revenue),
      lastDate: c.lastDate.substring(0, 10),
      grpName: effectiveGroup(c.email, c.grpName, ctx),
      shoptetGroup: c.grpName,
      cls: classify(c.email, c.grpType, c.grpName, ctx, c.vip ? "VIP-Datbáze" : "")
    };
  });
}
