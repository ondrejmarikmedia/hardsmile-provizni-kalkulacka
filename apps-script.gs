/**
 * Hardsmile kalkulačka – sdílené úložiště úprav.
 *
 * Uloží celý stav (fixní náklady, obraty, hodiny) jako JSON do ScriptProperties.
 * Nasazení:
 *   1. https://script.google.com  →  Nový projekt
 *   2. Vlož tento kód, ulož
 *   3. Nasadit → Nové nasazení → Typ: Webová aplikace
 *      - Spustit jako: Já
 *      - Kdo má přístup: Kdokoli
 *   4. Zkopíruj URL nasazení (končí na /exec) a pošli ji
 */

function doGet() {
  var v = PropertiesService.getScriptProperties().getProperty("STATE");
  return ContentService
    .createTextOutput(v || "{}")
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var body = (e && e.postData && e.postData.contents) || "{}";
    // ověření, že jde o validní JSON
    JSON.parse(body);
    PropertiesService.getScriptProperties().setProperty("STATE", body);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
