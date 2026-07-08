/**
 * Hardsmile — vytvoří NOVÝ Google Sheet s přepočtem provizí za všechny měsíce.
 *
 * Vstupní data (obraty, počty, ad costs, fixní náklady, hodiny) jsou VLOŽENA jako hodnoty.
 * Odvozené sloupce (marže, kredity, fixní podíl, provize, PNO, Kč/h) jsou ŽIVÉ VZORCE,
 * takže se vše přepočítá přímo v Sheetu (nezávislá kontrola výpočtů).
 *
 * Použití:
 *   1. https://script.google.com → Nový projekt → vlož tento kód → Ulož
 *   2. Nahoře vyber funkci "vytvorSheet" → klikni Spustit (Run)
 *   3. Povol oprávnění (jednorázově)
 *   4. V protokolu (View → Logs / Execution log) se objeví URL nového dokumentu
 *
 * Model (shodný s kalkulačkou):
 *   Marže        = ObratNEW × 70 %
 *   Podíl kred.  = ObratNEW / (ObratNEW + ObratMO)         (VO se do kreditů nezapočítává)
 *   Kredity→NEW  = Podíl kred. × Ad costs
 *   Podíl fix.   = ObratNEW / (ObratNEW + ObratMO + ObratVO)
 *   Fixní→NEW    = Podíl fix. × Fixní náklady
 *   Čistý obrat  = Marže − Kredity→NEW − Fixní→NEW
 *   Provize      = MAX(0; Čistý obrat × 40 %)
 *   PNO          = (Kredity→NEW + Fixní→NEW) / ObratNEW
 *   Kč/hodina    = Provize / Odpracované hodiny
 */

function vytvorSheet() {
  // month, rev_new, rev_mo, rev_vo, cnt_new, cnt_mo, cnt_vo, ad_cost, fixed, hours
  var DATA = [
    ["Říjen 2025",    51427.87,  43720.01,  4939.54,  50, 31, 3,  57504.21, 8566.01, 45],
    ["Listopad 2025", 91258.19,  42605.42,  6926.07,  97, 30, 2,  64216.58, 8566.01, 42],
    ["Prosinec 2025", 184020.76, 59419.92,  25239.45, 166,36, 6,  96503.91, 8566.01, 25],
    ["Leden 2026",    184386.30, 36137.62,  33944.87, 163,26, 1,  69820.48, 8566.01, 31],
    ["Únor 2026",     256129.71, 52081.25,  71957.04, 231,34, 6,  99722.72, 8566.01, 35],
    ["Březen 2026",   268682.63, 49423.55,  86042.14, 258,32, 2,  128272.27,8566.01, 48],
    ["Duben 2026",    222728.21, 56331.97,  19335.21, 206,44, 3,  102322.02,8566.01, 38],
    ["Květen 2026",   217079.08, 37314.37,  64751.34, 196,27, 2,  97895.05, 8566.01, 35],
    ["Červen 2026",   265009.95, 36308.15,  83201.47, 250,27, 6,  93280.59, 9462.01, 0],
    ["Červenec 2026", 92166.18,  9306.21,   56705.80, 83, 8,  1,  23684.52, 9462.01, 0]
  ];

  var ss = SpreadsheetApp.create("Hardsmile — provize (přepočet)");
  var sh = ss.getActiveSheet();
  sh.setName("Provize");

  var headers = [
    "Měsíc", "Obrat NEW", "Obrat MO", "Obrat VO",
    "Počet NEW", "Počet MO", "Počet VO", "Ad costs", "Fixní náklady", "Hodiny",
    "Marže 70 %", "Podíl kred.", "Kredity→NEW", "Podíl fix.", "Fixní→NEW",
    "Čistý obrat", "Provize 40 %", "PNO", "Kč/hodina"
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#f0fdf4");

  // Vstupní data (A–J) jako hodnoty
  sh.getRange(2, 1, DATA.length, 10).setValues(DATA);

  // Odvozené sloupce jako vzorce (K–S)
  for (var i = 0; i < DATA.length; i++) {
    var r = i + 2; // řádek v sheetu
    var f = [
      "=B" + r + "*0.7",                                  // K Marže
      "=IF(B" + r + "+C" + r + ">0; B" + r + "/(B" + r + "+C" + r + "); 1)", // L Podíl kred.
      "=L" + r + "*H" + r,                                // M Kredity→NEW
      "=IF(B" + r + "+C" + r + "+D" + r + ">0; B" + r + "/(B" + r + "+C" + r + "+D" + r + "); 1)", // N Podíl fix.
      "=N" + r + "*I" + r,                                // O Fixní→NEW
      "=K" + r + "-M" + r + "-O" + r,                     // P Čistý obrat
      "=MAX(0; P" + r + "*0.4)",                          // Q Provize
      "=IF(B" + r + ">0; (M" + r + "+O" + r + ")/B" + r + "; 0)", // R PNO
      "=IF(J" + r + ">0; Q" + r + "/J" + r + "; 0)"       // S Kč/hodina
    ];
    sh.getRange(r, 11, 1, f.length).setFormulas([f]);
  }

  // Součtový řádek
  var tot = DATA.length + 2;
  sh.getRange(tot, 1).setValue("CELKEM").setFontWeight("bold");
  var sumCols = ["B", "C", "D", "E", "F", "G", "H", "K", "M", "O", "P", "Q"];
  sumCols.forEach(function (col) {
    sh.getRange(col + tot).setFormula("=SUM(" + col + "2:" + col + (tot - 1) + ")").setFontWeight("bold");
  });
  sh.getRange(tot, 1, 1, headers.length).setBackground("#f0fdf4");

  // Formátování
  sh.getRange(2, 12, DATA.length, 1).setNumberFormat("0.0%"); // L Podíl kred.
  sh.getRange(2, 14, DATA.length, 1).setNumberFormat("0.0%"); // N Podíl fix.
  sh.getRange(2, 18, DATA.length, 1).setNumberFormat("0.0%"); // R PNO
  sh.getRange(2, 2, DATA.length + 1, 3).setNumberFormat("#,##0 \"Kč\"");   // obraty
  sh.getRange(2, 8, DATA.length + 1, 2).setNumberFormat("#,##0 \"Kč\"");   // ad, fixní
  sh.getRange(2, 11, DATA.length + 1, 1).setNumberFormat("#,##0 \"Kč\"");  // marže
  sh.getRange(2, 13, DATA.length + 1, 1).setNumberFormat("#,##0 \"Kč\"");  // kredity
  sh.getRange(2, 15, DATA.length + 1, 4).setNumberFormat("#,##0 \"Kč\"");  // fixní→, čistý, provize
  sh.getRange(2, 19, DATA.length, 1).setNumberFormat("#,##0 \"Kč\"");      // Kč/h
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);

  // Legenda s modelem
  var leg = ss.insertSheet("Model");
  leg.getRange(1, 1, 9, 2).setValues([
    ["Konstanta / vzorec", "Hodnota / definice"],
    ["Marže", "70 %"],
    ["Provize", "40 % z čistého obratu"],
    ["Podíl kred.", "ObratNEW / (ObratNEW + ObratMO) — VO se do kreditů nezapočítává"],
    ["Kredity→NEW", "Podíl kred. × Ad costs"],
    ["Podíl fix.", "ObratNEW / (ObratNEW + ObratMO + ObratVO)"],
    ["Fixní→NEW", "Podíl fix. × Fixní náklady"],
    ["Čistý obrat", "Marže − Kredity→NEW − Fixní→NEW"],
    ["Provize", "MAX(0; Čistý obrat × 40 %)"]
  ]);
  leg.getRange(1, 1, 1, 2).setFontWeight("bold").setBackground("#f0fdf4");
  leg.autoResizeColumns(1, 2);

  var url = ss.getUrl();
  Logger.log("HOTOVO. Nový dokument: " + url);
  return url;
}
