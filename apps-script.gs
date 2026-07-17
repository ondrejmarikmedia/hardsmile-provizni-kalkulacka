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
    JSON.parse(body);
    PropertiesService.getScriptProperties().setProperty("STATE", body);
    // Ruční VO seznam se mohl změnit → zneplatni cache agregace, ať se hned projeví.
    try { CacheService.getScriptCache().remove("ORDERS_AGG"); } catch (ce) {}
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
  Object.keys(col).forEach(function (h) { if (/pozn|note|remark/i.test(h)) noteCol = col[h]; });
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

// Zařadí objednávku/zákazníka do NEW/MO/VO. Priorita: ruční třída → skupina VO(vč. VIP) → seznam(MO) → NEW.
function classify(email, grpType, grpName, ctx) {
  var ov = ctx.classOverride[email];
  if (ov === "NEW" || ov === "MO" || ov === "VO") return ov;
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
    if (!agg[ym]) agg[ym] = { rev_new: 0, rev_mo: 0, rev_vo: 0, cnt_new: 0, cnt_mo: 0, cnt_vo: 0, rev_rep: 0, cnt_rep: 0 };
    var cls = classify(o.email, o.grpType, o.grpName, ctx);
    if (cls === "VO") { agg[ym].rev_vo += o.price; agg[ym].cnt_vo++; }
    else if (cls === "MO") { agg[ym].rev_mo += o.price; agg[ym].cnt_mo++; }
    else { agg[ym].rev_new += o.price; agg[ym].cnt_new++; }
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
    if (!byEmail[o.email]) byEmail[o.email] = { email: o.email, orders: 0, revenue: 0, lastDate: "", grpName: o.grpName, grpType: o.grpType };
    var c = byEmail[o.email];
    c.orders++;
    c.revenue += o.price;
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
      cls: classify(c.email, c.grpType, c.grpName, ctx)
    };
  });
}
