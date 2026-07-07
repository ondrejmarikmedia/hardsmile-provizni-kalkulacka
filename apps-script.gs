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

function doGet(e) {
  var p = (e && e.parameter) || {};
  var body;
  if (p.orders) {
    body = getOrdersAgg();
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

function computeOrdersAgg() {
  var resp = UrlFetchApp.fetch(SHOPTET_ORDERS_URL, { muteHttpExceptions: true });
  var text = resp.getContentText("windows-1250");
  var lines = text.split(/\r?\n/);
  var header = parseCsvLine(lines[0]).map(function (h) { return h.replace(/"/g, "").trim(); });
  var col = {};
  header.forEach(function (h, i) { col[h] = i; });

  // odděl 1 řádek na objednávku (totalPriceWithoutVat je totožná na všech řádcích objednávky)
  var seenId = {};
  var orders = [];
  for (var i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    var f = parseCsvLine(lines[i]).map(function (x) { return x.replace(/^"|"$/g, ""); });
    var id = f[col["id"]];
    if (!id || seenId[id]) continue;
    seenId[id] = true;
    orders.push({
      id: id,
      date: f[col["date"]] || "",
      email: (f[col["email"]] || "").toLowerCase(),
      grpType: f[col["customerGroupType"]] || "",
      price: num(f[col["totalPriceWithoutVat"]])
    });
  }

  orders.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  var seenEmail = {};
  var agg = {};
  orders.forEach(function (o) {
    if (o.date.length < 7) return;
    var ym = o.date.substring(0, 7);
    if (!agg[ym]) agg[ym] = { rev_new: 0, rev_mo: 0, rev_vo: 0, cnt_new: 0, cnt_mo: 0, cnt_vo: 0 };
    if (o.grpType === "customerGroupTypeWholesale") {
      agg[ym].rev_vo += o.price; agg[ym].cnt_vo++;
    } else if (!seenEmail[o.email]) {
      seenEmail[o.email] = true;
      agg[ym].rev_new += o.price; agg[ym].cnt_new++;
    } else {
      agg[ym].rev_mo += o.price; agg[ym].cnt_mo++;
    }
  });
  return agg;
}
