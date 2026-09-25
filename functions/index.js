/**
 * Cloud Functions pro appku Trenér — notifikace (fáze 1 a 2, 23. 9. 2026).
 *
 * Appka sama neumí poslat notifikaci, když je zavřená nebo je telefon zamčený — na to je
 * potřeba tenhle serverový kousek, který hlídá Firestore a posílá push přes Firebase Cloud
 * Messaging. Posílá se na zařízení uložená v users/{uid}.fcmTokens (ukládá je appka).
 *
 * KOMU SE POSÍLÁ:
 *  - adminovi (ADMIN_UID) všechno z fáze 1 — dění v knihovně, tréninky, lidé, zpětná vazba,
 *    s možností vypnout tři skupiny (notifyGroups),
 *  - ostatním trenérům jen to, co se týká přímo jich (fáze 2, Mekova varianta A: jediný
 *    vypínač, žádné skupiny): komentář u jejich videa, zmínka, hodnocení jejich videa,
 *    zkopírování jejich tréninku, vyřízený tip, schválený přístup.
 *
 * Mekova rozhodnutí 23. 9. 2026, podle kterých je to postavené:
 *  - fáze 1 = jen admin (trenéři přijdou v dalším kole),
 *  - tlumení podle typu: po odeslání se stejný typ 10 minut neposílá, další události se
 *    počítají a připočtou se k nejbližší další hlášce („a 3 další změny“),
 *  - noční klid 22:00–8:00 (Praha): neposílá se nic, v appce ve zvonečku všechno zůstává,
 *  - „někdo je online“ jen při prvním příchodu daného trenéra za den,
 *  - tři skupiny na vypnutí: knihovna a tréninky / lidé / videa a zpětná vazba,
 *  - ťuknutí na notifikaci otevře přímo to, čeho se týká (?open=… v index.html).
 *
 * POZOR NA SMYČKU: žádná z těchhle funkcí nesmí zapisovat do kolekce, kterou sama hlídá.
 * Stav tlumení proto bydlí v samostatné kolekci notifyState, kam nikdo jiný nesahá.
 *
 * RAZÍTKO OBNOVY (24. 9. 2026): co vrací obnova ze zálohy, nese pole restoredAt. Takový zápis
 * není práce trenéra, takže se nehlásí — viz jeObnova() níž (Mekovo rozhodnutí A, otázka 7).
 *
 * KNIHOVNA PO VIDEÍCH (krok 5, 25. 9. 2026): aplikace už nepíše kopii knihovny („šanon“)
 * do shared/data. Hlášky o videích proto hlídá onVideoChange nad kolekcí videos; hlídání
 * shared/data zůstává jen pro složky, štítky a vybavení.
 *
 * NASAZENÍ (dělá Mek z počítače):
 *   cd functions && npm install
 *   firebase deploy --only functions
 */
const { onDocumentUpdated, onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Frankfurt — nejbližší region k ČR. maxInstances je pojistka proti utržení: i kdyby se
// něco zacyklilo, nepoběží víc než deset kopií najednou.
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

const ADMIN_UID = "WIw1KfRofOOrbYF7Xl8YzgQrTZd2";
const APP_URL = "https://mek2424.github.io/traner/index.html";
const ICON_URL = "https://mek2424.github.io/traner/icon-192.png";

const THROTTLE_MS = 10 * 60 * 1000;   // tlumení podle typu
const QUIET_FROM = 22;                 // noční klid od (včetně)
const QUIET_TO = 8;                    // noční klid do (bez)

/** Typ notifikace → skupina, kterou jde v appce vypnout (profil → Notifikace). */
const TYPE_GROUP = {
  library: "library",        // změny knihovny
  videoAdded: "library",     // přidané video (nebo vrácené z koše) — krok 5, po videích
  videoEdited: "library",    // upravené video — krok 5, po videích
  videoDeleted: "library",   // smazané video (zvlášť, je to nevratné)
  training: "library",       // tréninky ostatních
  trainingCloned: "library", // někdo si zkopíroval Mekův trénink
  access: "people",          // žádost o přístup
  online: "people",          // první příchod trenéra za den
  rating: "videos",          // hodnocení videa hvězdičkami
  difficulty: "videos",      // nastavená obtížnost
  note: "videos",            // poznámka trenéra u videa
  tip: "videos",             // tip na video od prohlížeče
  tipResolved: "videos",     // vyřízený tip (chodí tomu, kdo tip poslal — fáze 2)
  comment: "videos",         // komentáře a zmínky
  goneReport: "videos",      // hlášení „video zmizelo u zdroje“
  autoCheck: "videos"        // nález automatické kontroly videí
};

/** RAZÍTKO OBNOVY (24. 9. 2026). Obnova ze zálohy (jen admin, Správa → Obnovit ze zálohy)
    připíše ke každému dokumentu, který vrací, pole restoredAt s časem obnovy. Zápis, který
    razítko PŘINESL (před ním nebylo, nebo bylo jiné), je obnova — nehlásí se, jinak by
    trenérům chodily falešné hlášky („zkopíroval tvůj trénink“, „video zmizelo“…).
    Pozdější běžné úpravy téhož dokumentu nesou razítko dál beze změny, takže se hlásí
    normálně. Dokument, který vznikl rovnou s razítkem (pred = null), je taky obnova. */
function jeObnova(pred, po) {
  if (!po || !po.restoredAt) return false;
  return !pred || pred.restoredAt !== po.restoredAt;
}

/** „jednou hvězdičkou“ / „4 hvězdičkami“ — ať to není „1 hvězdičkami“. */
function hvezdicky(n) {
  return n === 1 ? "jednou hvězdičkou" : `${n} hvězdičkami`;
}
/** České množné číslo bez psaní „1 změn(a)“. */
function pocet(n, jedna, dve, pet) {
  return n === 1 ? `1 ${jedna}` : (n >= 2 && n <= 4 ? `${n} ${dve}` : `${n} ${pet}`);
}

/* Texty zpětné vazby k JEDNOMU videu (hlídání jednotlivých videí, onVideoChange).
   v = { nazev, hodnota } */
const NADPIS_ZPETNE_VAZBY = { rating: "Trenér — hodnocení", difficulty: "Trenér — obtížnost", note: "Trenér — poznámka u videa" };
const TEXT_ZPETNE_VAZBY = {
  rating: (v) => v.hodnota ? `ohodnotil(a) „${v.nazev}“ ${hvezdicky(v.hodnota)}` : `zrušil(a) svoje hodnocení u „${v.nazev}“`,
  difficulty: (v) => v.hodnota ? `nastavil(a) obtížnost u „${v.nazev}“ na ${v.hodnota}` : `zrušil(a) svoje hodnocení obtížnosti u „${v.nazev}“`,
  note: (v) => v.hodnota ? `napsal(a) poznámku u „${v.nazev}“` : `smazal(a) svoji poznámku u „${v.nazev}“`
};
// Texty pro majitele videa (fáze 2) — vlastní, ne poskládané z těch adminských, ať to zní česky.
const TEXT_MAJITELI = {
  rating: (v) => v.hodnota ? `ohodnotil(a) tvoje video „${v.nazev}“ ${hvezdicky(v.hodnota)}` : `zrušil(a) hodnocení u tvého videa „${v.nazev}“`,
  difficulty: (v) => v.hodnota ? `nastavil(a) obtížnost u tvého videa „${v.nazev}“ na ${v.hodnota}` : `zrušil(a) hodnocení obtížnosti u tvého videa „${v.nazev}“`,
  note: (v) => v.hodnota ? `napsal(a) poznámku u tvého videa „${v.nazev}“` : `smazal(a) poznámku u tvého videa „${v.nazev}“`
};
/** Zpětná vazba má v dokumentu videa tahle pole (mapa uid → hodnota). */
const POLE_ZPETNE_VAZBY = { rating: "ratings", difficulty: "difficulties", note: "notesByCoach" };

/** JSON se seřazenými klíči. Pořadí klíčů v mapách Firestore nezaručuje, a bez řazení by
    stejná data mohla vypadat jako změna. */
function stabilni(v) {
  if (Array.isArray(v)) return "[" + v.map(stabilni).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stabilni(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}
/** Seznamy, které v shared/data zůstaly i po kroku 5. */
const SEZNAMY_KNIHOVNY = ["folders", "tagPool", "equipmentPool", "parts", "trainingFocus", "focusLibraryMap"];

/** Je teď v Praze noční klid? Počítá se z pražského času, ne z času serveru (ten jede v UTC),
    takže to sedí i po přechodu na zimní čas. */
function jeNocniKlid(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat("cs-CZ", { timeZone: "Europe/Prague", hour: "numeric", hour12: false }).format(now));
  return h >= QUIET_FROM || h < QUIET_TO;
}

/** Dnešek v Praze jako YYYY-MM-DD — klíč pro „první příchod za den“. */
function prazskyDen(ms) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date(ms));
}

async function nastaveni(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const d = snap.exists ? snap.data() : {};
  const g = d.notifyGroups || {};
  return {
    enabled: !!d.notifyPushEnabled,
    tokens: Array.isArray(d.fcmTokens) ? d.fcmTokens : [],
    // Chybějící skupina = zapnutá. Vypnutá je jen ta, u které je výslovně false.
    // Skupiny má v appce jen admin; ostatním trenérům se neuplatňují (jediný vypínač).
    groups: { library: g.library !== false, people: g.people !== false, videos: g.videos !== false }
  };
}

async function jmeno(uid) {
  if (!uid) return "Někdo";
  try {
    const snap = await db.collection("users").doc(uid).get();
    const d = snap.exists ? snap.data() : {};
    return d.username || "Trenér";
  } catch (e) {
    return "Trenér";
  }
}

/** Odeslání na všechna uložená zařízení + úklid tokenů, které prohlížeč zneplatnil
    (odhlášení, smazaná data prohlížeče, přeinstalace). Posílá se DATOVÁ zpráva, ne
    „notification“ — notifikaci vykresluje sw.js (onBackgroundMessage), díky čemuž si
    appka může sama ošetřit i ťuknutí (otevřít, co k notifikaci patří, bez načtení znovu). */
async function posli(uid, tokens, { title, body, url, type }) {
  if (!tokens.length) return { sent: 0, ok: 0, fail: 0, kody: [] };
  const resp = await messaging.sendEachForMulticast({
    tokens,
    data: { title, body, url: url || APP_URL, type: type || "", icon: ICON_URL },
    webpush: { headers: { Urgency: "normal", TTL: "86400" } }
  });
  const mrtve = [];
  const kody = [];
  resp.responses.forEach((r, i) => {
    if (r.success) return;
    const code = (r.error && r.error.code) || "neznámá chyba";
    if (kody.indexOf(code) === -1) kody.push(code);
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
      mrtve.push(tokens[i]);
    }
  });
  if (mrtve.length) {
    await db.collection("users").doc(uid).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...mrtve)
    });
  }
  /* Do logu Cloud Functions (24. 9. 2026). Dřív se odpověď od FCM nikam nezapisovala, takže
     když zprávu odmítl, appka i log tvrdily „odesláno“ a nebylo se čeho chytit. */
  console.log(`[notifikace] ${uid} typ=${type || "-"}: zařízení ${tokens.length}, přijato ${resp.successCount}, odmítnuto ${resp.failureCount}${kody.length ? ", chyby: " + kody.join(", ") : ""}${mrtve.length ? ", mrtvých adres smazáno: " + mrtve.length : ""}`);
  return { sent: tokens.length, ok: resp.successCount, fail: resp.failureCount, kody };
}

/**
 * Jediná cesta ven. Postupně: zapnuto? je komu? není skupina vypnutá? není noční klid?
 * a nakonec tlumení podle typu — když stejný typ odešel před méně než deseti minutami,
 * událost se jen připočte a text se přilepí k nejbližší další hlášce téhož typu.
 */
async function notifikuj(uid, { type, title, body, url, key }) {
  if (!uid) return;
  const prefs = await nastaveni(uid);
  if (!prefs.enabled || !prefs.tokens.length) return;
  // Skupiny se týkají jen admina — ostatní mají v appce jediný vypínač (Mek 23. 9.).
  if (uid === ADMIN_UID && prefs.groups[TYPE_GROUP[type] || "library"] === false) return;
  if (jeNocniKlid()) return;

  /* Klíč tlumení je normálně typ. Výjimka je „někdo je online“: tam se tlumí zvlášť pro
     každého trenéra (key = online:uid), jinak by se při dvou příchodech za sebou ztratilo
     jméno toho druhého. Že to nezahltí, hlídá už pravidlo „jednou denně na trenéra“. */
  const stavKlic = key || type;
  const ref = db.collection("notifyState").doc(uid);
  const now = Date.now();
  let cekajici = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = (snap.exists ? snap.data() : {})[stavKlic] || {};
    const last = d.lastAt || 0;
    const pending = d.pending || 0;
    if (now - last < THROTTLE_MS) {
      tx.set(ref, { [stavKlic]: { lastAt: last, pending: pending + 1 } }, { merge: true });
      return;
    }
    cekajici = pending;
    tx.set(ref, { [stavKlic]: { lastAt: now, pending: 0 } }, { merge: true });
  });
  if (cekajici === null) return;   // utlumeno, pošle se to s příští hláškou téhož typu

  const dovetek = cekajici > 0 ? ` (a mezitím ${pocet(cekajici, "další změna", "další změny", "dalších změn")})` : "";
  await posli(uid, prefs.tokens, { title, body: body + dovetek, url, type });
}

/* =========================================================
   1) SEZNAMY KNIHOVNY (složky, štítky, vybavení) — dokument shared/data
   Od kroku 5 (25. 9. 2026) v shared/data knihovna nebydlí, jen seznamy; videa hlídá
   onVideoChange níž. Aplikace při uložení seznamů píše i lastEditedBy — podle toho se pozná,
   kdo změnu udělal, a Mekovy vlastní změny se přeskočí.
   ÚKLID 25. 9. (Mekova volba A): pryč je porovnávání starého šanonu (pole library), které
   v přechodu hlídalo starou verzi aplikace. Kdyby šanon ještě zapsala zapomenutá stará
   verze, nenahlásí se nic — horšího se stát nemůže.
   ========================================================= */
exports.onSharedDataChange = onDocumentUpdated("shared/data", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  if (jeObnova(before, after)) return;
  const editorUid = after.lastEditedBy;
  if (!editorUid || editorUid === ADMIN_UID) return;

  const casti = [];
  const delta = (a, b) => (b || []).length - (a || []).length;
  const dSlozky = delta(before.folders, after.folders);
  const dStitky = delta(before.tagPool, after.tagPool);
  const dVybaveni = delta(before.equipmentPool, after.equipmentPool);
  if (dSlozky > 0) casti.push("přidal(a) složku");
  else if (dSlozky < 0) casti.push("smazal(a) složku");
  if (dStitky > 0) casti.push("přidal(a) nový štítek");
  if (dVybaveni > 0) casti.push("přidal(a) nové vybavení");

  if (!casti.length) {
    /* Obecná hláška jen tehdy, když se v seznamech opravdu něco změnilo. Zápisy, které
       seznamy nemění (uložení klíče, smazání šanonu), lastEditedBy nepřepisují — dřív z nich
       vycházela hláška pod jménem toho, kdo ukládal naposledy předtím. */
    if (!SEZNAMY_KNIHOVNY.some(k => stabilni(before[k]) !== stabilni(after[k]))) return;
    casti.push("upravil(a) nastavení knihovny (složky, štítky nebo vybavení)");
  }
  const kdo = await jmeno(editorUid);
  await notifikuj(ADMIN_UID, {
    type: "library",
    title: "Trenér — změna v knihovně",
    body: `${kdo} ${casti.join(", ")}.`,
    url: APP_URL
  });
});

/* =========================================================
   1b) JEDNOTLIVÁ VIDEA (krok 5 přepisu knihovny, 25. 9. 2026)
   Knihovna bydlí jen v kolekci videos (co dokument, to video), takže hlášky o videích
   vznikají tady, po jednom videu. Kdo změnu udělal, nese video samo: aplikace ke každému
   zápisu videa přidá lastEditedBy a čerstvý lastEditedAt.
   ČERSTVÝ ČAS JE PODMÍNKA. Zápis, který čas nezměnil, nebyl úpravou v nové verzi aplikace:
   buď ukládala stará verze (o razítku neví a posílá zpátky, co přečetla; od úklidu 25. 9.
   se její změny nehlásí vůbec), nebo úklid po smazaném účtu.
   Mekova volba A (25. 9.): změna víc videí najednou se nesčítá — první video se pojmenuje,
   další spolkne tlumení („a mezitím N dalších změn“ u příští hlášky stejného druhu).
   Automatickou kontrolu videí hlásí dál onVideoAutoCheck níž.
   ========================================================= */
/** Pole videa, která nejsou jeho obsahem. Jejich změna není „úprava videa“: zpětná vazba má
    vlastní hlášky, hlášení a kontroly jiné cesty, hvězdička oblíbených je jen značka. */
const VIDEO_NENI_OBSAH = new Set([
  "ratings", "difficulties", "notesByCoach",
  "goneAt", "goneResolvedAt", "brokenAt", "autoCheck", "autoCheckIgnoreUrl",
  "share", "favorite", "deletedAt", "restoredAt",
  "lastEditedBy", "lastEditedAt", "addedBy", "dateAdded", "id"
]);
function prazdne(v) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
}
/** Která pole obsahu se mezi dvěma verzemi videa liší. Prázdné hodnoty (chybí, null, "", [])
    se berou jako stejné — formulář je ukládá různě a úprava to není. */
function zmenenyObsahVidea(a, b) {
  const klice = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...klice].filter(k => {
    if (VIDEO_NENI_OBSAH.has(k)) return false;
    const x = (a || {})[k], y = (b || {})[k];
    if (prazdne(x) && prazdne(y)) return false;
    return stabilni(x) !== stabilni(y);
  });
}

exports.onVideoChange = onDocumentWritten("videos/{videoId}", async (event) => {
  const id = event.params.videoId;
  const pred = event.data.before.exists ? event.data.before.data() : null;
  const po = event.data.after.exists ? event.data.after.data() : null;
  // Natrvalo smazané video (vysypaný koš) se nehlásí — hlásilo se už při přesunu do koše.
  if (!po) return;
  if (jeObnova(pred, po)) return;
  const editorUid = po.lastEditedBy;
  if (!editorUid || !po.lastEditedAt) return;
  if (pred && pred.lastEditedAt === po.lastEditedAt) return;
  if (editorUid === ADMIN_UID) return;

  const nazev = po.title || (pred && pred.title) || "video";
  const odkaz = `${APP_URL}?open=video&id=${encodeURIComponent(id)}`;
  const zivePred = !!pred && !pred.deletedAt;
  const zivePo = !po.deletedAt;
  const kdo = await jmeno(editorUid);

  if (!zivePred && zivePo) {
    await notifikuj(ADMIN_UID, {
      type: "videoAdded",
      title: "Trenér — změna v knihovně",
      body: pred ? `${kdo} vrátil(a) „${nazev}“ z koše.` : `${kdo} přidal(a) video „${nazev}“.`,
      url: odkaz
    });
    return;
  }
  if (zivePred && !zivePo) {
    await notifikuj(ADMIN_UID, {
      type: "videoDeleted",
      title: "Trenér — smazané video",
      body: `${kdo} smazal(a) „${nazev}“.`,
      url: APP_URL
    });
    return;
  }
  if (!zivePo) return;   // úprava videa, které leží v koši

  /* Zpětná vazba: stejně jako dřív se porovnávají JEN hodnoty toho, kdo ukládal. Adminovi
     hláška vždycky, majiteli videa (addedBy) taky — kromě admina a toho, kdo ji napsal. */
  for (const typ of ["rating", "difficulty", "note"]) {
    const pole = POLE_ZPETNE_VAZBY[typ];
    // „|| null“ jako dřív u šanonu: chybějící, null i prázdná poznámka znamenají „nic“.
    const a = (po[pole] || {})[editorUid] || null;
    const b = (pred[pole] || {})[editorUid] || null;
    if (stabilni(a) === stabilni(b)) continue;
    const v = { nazev, hodnota: typ === "note" ? a !== null : a };
    await notifikuj(ADMIN_UID, {
      type: typ,
      title: NADPIS_ZPETNE_VAZBY[typ],
      body: `${kdo} ${TEXT_ZPETNE_VAZBY[typ](v)}.`,
      url: odkaz
    });
    const majitel = po.addedBy;
    if (majitel && majitel !== editorUid && majitel !== ADMIN_UID) {
      await notifikuj(majitel, {
        type: typ,
        title: NADPIS_ZPETNE_VAZBY[typ],
        body: `${kdo} ${TEXT_MAJITELI[typ](v)}.`,
        url: odkaz
      });
    }
  }

  if (zmenenyObsahVidea(pred, po).length) {
    await notifikuj(ADMIN_UID, {
      type: "videoEdited",
      title: "Trenér — změna v knihovně",
      body: `${kdo} upravil(a) video „${nazev}“.`,
      url: odkaz
    });
  }
});

/* =========================================================
   2) TRÉNINKY OSTATNÍCH TRENÉRŮ
   {uid} je zástupný znak, takže trigger chytá zápisy všech trenérů; Mekovy vlastní se
   přeskočí. Klon cizího tréninku si appka značí (clonedFromOwnerUid) — když je zdrojem
   Mek, pozná se z toho „někdo si zkopíroval tvůj trénink“.
   ========================================================= */
exports.onTrainingChange = onDocumentWritten("users/{uid}/trainings/{trainingId}", async (event) => {
  const uid = event.params.uid;
  if (uid === ADMIN_UID) return;

  const bylo = event.data.before.exists;
  const je = event.data.after.exists;
  // Vrácení tréninku ze zálohy (i smazaného) není práce trenéra — nehlásí se.
  if (je && jeObnova(bylo ? event.data.before.data() : null, event.data.after.data())) return;
  const src = je ? event.data.after.data() : (event.data.before.data() || {});
  const nazev = src.name || "trénink";
  const kdo = await jmeno(uid);
  const url = `${APP_URL}?open=training&u=${encodeURIComponent(uid)}&id=${encodeURIComponent(event.params.trainingId)}`;

  // Kopie cizího tréninku: dá se vědět tomu, od koho se kopírovalo (fáze 2 — nejen adminovi).
  if (!bylo && je && src.clonedFromOwnerUid && src.clonedFromOwnerUid !== uid) {
    await notifikuj(src.clonedFromOwnerUid, {
      type: "trainingCloned",
      title: "Trenér — kopie tvého tréninku",
      body: `${kdo} si zkopíroval(a) tvůj trénink „${src.clonedFromName || nazev}“.`,
      url
    });
    // Když se kopírovalo od admina, má z toho hlášku a druhá („vytvořil nový trénink“) by
    // byla o tomtéž. Když se kopírovalo od někoho jiného, admin se o novém tréninku dozví níž.
    if (src.clonedFromOwnerUid === ADMIN_UID) return;
  }

  let co;
  if (!bylo) co = `vytvořil(a) nový trénink „${nazev}“`;
  else if (!je) co = `smazal(a) trénink „${nazev}“`;
  else co = `upravil(a) trénink „${nazev}“`;
  await notifikuj(ADMIN_UID, { type: "training", title: "Trenér — trénink", body: `${kdo} ${co}.`, url: je ? url : APP_URL });
});

/* =========================================================
   3) NĚKDO PŘIŠEL ONLINE — jen první příchod daného trenéra za den (Mekova varianta C).
   Appka píše do users/{uid}.heartbeatAt, dokud je otevřená. Tenhle trigger se tím pádem
   spouští často, ale skoro vždycky hned skončí: buď se heartbeat nezměnil, nebo už dneska
   hláška o tomhle člověku odešla (notifyState/online drží den u každého uid).
   ========================================================= */
exports.onUserHeartbeat = onDocumentWritten("users/{uid}", async (event) => {
  const uid = event.params.uid;
  if (uid === ADMIN_UID) return;
  if (!event.data.after.exists) return;

  const before = event.data.before.exists ? (event.data.before.data() || {}) : {};
  const after = event.data.after.data() || {};
  if (jeObnova(event.data.before.exists ? before : null, after)) return;
  if (!after.heartbeatAt || after.heartbeatAt === before.heartbeatAt) return;

  const den = prazskyDen(after.heartbeatAt);
  const ref = db.collection("notifyState").doc("online");
  let poprve = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    if (d[uid] === den) return;
    poprve = true;
    tx.set(ref, { [uid]: den }, { merge: true });
  });
  if (!poprve) return;

  const kdo = after.username || before.username || "Trenér";
  await notifikuj(ADMIN_UID, { type: "online", key: `online:${uid}`, title: "Trenér — online", body: `${kdo} je dneska poprvé v appce.`, url: APP_URL });
});

/* =========================================================
   4) ŽÁDOST O PŘÍSTUP — nový účet čeká na schválení.
   ========================================================= */
exports.onAccessRequest = onDocumentCreated("pendingRequests/{uid}", async (event) => {
  const d = (event.data && event.data.data()) || {};
  if (event.params.uid === ADMIN_UID) return;
  await notifikuj(ADMIN_UID, {
    type: "access",
    title: "Trenér — žádost o přístup",
    body: `${d.email || "Někdo nový"} čeká na schválení.`,
    url: `${APP_URL}?open=sprava`
  });
});

/* =========================================================
   5) TIP NA VIDEO od prohlížeče.
   ========================================================= */
exports.onVideoTip = onDocumentCreated("videoTips/{tipId}", async (event) => {
  const d = (event.data && event.data.data()) || {};
  if (d.restoredAt) return;   // tip vrácený ze zálohy, ne nový
  if (!d.fromUid || d.fromUid === ADMIN_UID) return;
  const kdo = d.fromLabel || await jmeno(d.fromUid);
  await notifikuj(ADMIN_UID, {
    type: "tip",
    title: "Trenér — tip na video",
    body: `${kdo} poslal(a) tip: ${d.title || d.url || "nové video"}`,
    url: `${APP_URL}?open=tipy`
  });
});

/* =========================================================
   6) KOMENTÁŘE, ZMÍNKY A HLÁŠENÍ „VIDEO ZMIZELO U ZDROJE“.
   Všechno tohle appka zapisuje do commentActivity (odtud jede i zvoneček „Co je nového“).
   Hlášení „video nejde přehrát v appce“ (isBrokenReport) se ZÁMĚRNĚ neposílá — Mek 23. 9.:
   „je to poměrně časté, jen šum“. Ve zvonečku v appce zůstává.
   ========================================================= */
exports.onCommentActivity = onDocumentCreated("commentActivity/{id}", async (event) => {
  const d = (event.data && event.data.data()) || {};
  if (d.restoredAt) return;   // záznam vrácený ze zálohy, ne nový komentář
  if (!d.authorUid || d.authorUid === ADMIN_UID) return;
  if (d.isBrokenReport) return;
  if (d.goneEvent === "retract") return;   // stažené hlášení: počet ve Správě se sníží sám

  const nazev = d.videoTitle || "video";
  const url = d.videoId ? `${APP_URL}?open=video&id=${encodeURIComponent(d.videoId)}` : APP_URL;

  if (d.isGoneReport || d.goneEvent === "report") {
    await notifikuj(ADMIN_UID, {
      type: "goneReport",
      title: "Trenér — nahlášené video",
      body: `${d.authorLabel || "Trenér"}: „${nazev}“ nejde přehrát ani u zdroje.`,
      url
    });
    return;
  }

  const zminky = Array.isArray(d.mentions) ? d.mentions : [];
  const autor = d.authorLabel || "Trenér";
  const text = (d.text || "").slice(0, 120);
  await notifikuj(ADMIN_UID, {
    type: "comment",
    title: zminky.includes(ADMIN_UID) ? "Trenér — zmínka v komentáři" : "Trenér — nový komentář",
    body: `${autor} u „${nazev}“: ${text}`,
    url
  });
  /* Fáze 2: komentář patří i tomu, kdo video přidal, a každému, koho komentář zmiňuje.
     Admin má svoji hlášku výš, autor komentáře si psát sám sobě nemusí, a kdo je zároveň
     majitel i zmíněný, dostane jednu hlášku (hotovo drží, komu už to odešlo). */
  const hotovo = new Set([ADMIN_UID, d.authorUid]);
  if (d.videoOwnerUid && !hotovo.has(d.videoOwnerUid)) {
    hotovo.add(d.videoOwnerUid);
    await notifikuj(d.videoOwnerUid, {
      type: "comment",
      title: "Trenér — komentář u tvého videa",
      body: `${autor} u „${nazev}“: ${text}`,
      url
    });
  }
  for (const kdoZminen of zminky) {
    if (hotovo.has(kdoZminen)) continue;
    hotovo.add(kdoZminen);
    await notifikuj(kdoZminen, {
      type: "comment",
      title: "Trenér — zmínka v komentáři",
      body: `${autor} tě zmínil(a) u „${nazev}“: ${text}`,
      url
    });
  }
});

/* =========================================================
   8) VYŘÍZENÝ TIP — fáze 2. Prohlížeč, který tip poslal, se dozví, jak dopadl.
   ========================================================= */
exports.onVideoTipResolved = onDocumentUpdated("videoTips/{tipId}", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  if (jeObnova(before, after)) return;
  if (before.status === after.status) return;
  if (after.status !== "approved" && after.status !== "rejected") return;
  if (!after.fromUid || after.fromUid === ADMIN_UID) return;

  const nazev = after.title || after.url || "tvůj tip";
  const zarazeno = after.status === "approved";
  const duvod = (after.rejectReason || "").trim();
  await notifikuj(after.fromUid, {
    type: "tipResolved",
    title: zarazeno ? "Trenér — tip zařazen" : "Trenér — tip nezařazen",
    body: zarazeno
      ? `„${nazev}“ je v knihovně. Díky!`
      : `„${nazev}“ se do knihovny nedostal.${duvod ? " Důvod: " + duvod.slice(0, 120) : ""}`,
    url: zarazeno && after.libraryId
      ? `${APP_URL}?open=video&id=${encodeURIComponent(after.libraryId)}`
      : `${APP_URL}?open=mojetipy`
  });
});

/* =========================================================
   9) SCHVÁLENÝ PŘÍSTUP — fáze 2. Seznam schválených je jeden dokument shared/members,
   takže se porovná, čí uid v něm nově přibylo. Pozn.: nový trenér notifikace zapnuté
   většinou nemá (nemá kde — do appky se ještě nedostal), takže tohle pípne hlavně tomu,
   kdo u sebe Trenéra už někdy měl.
   ========================================================= */
exports.onMembersChange = onDocumentUpdated("shared/members", async (event) => {
  // Trenér vrácený do seznamu obnovou ze zálohy nedostane „Mek ti schválil přístup“.
  if (jeObnova(event.data.before.data() || {}, event.data.after.data() || {})) return;
  const pred = ((event.data.before.data() || {}).approved) || {};
  const po = ((event.data.after.data() || {}).approved) || {};
  const pribyli = Object.keys(po).filter(uid => !pred[uid] && uid !== ADMIN_UID);
  for (const uid of pribyli) {
    await notifikuj(uid, {
      type: "access",
      title: "Trenér — přístup schválen",
      body: "Mek ti schválil přístup do Trenéra. Můžeš začít.",
      url: APP_URL
    });
  }
});

/* =========================================================
   7) NÁLEZ AUTOMATICKÉ KONTROLY VIDEÍ.
   Appka kontrolu pouští u admina po přihlášení a nález si ukládá do videos/{id}.autoCheck.
   Sama nic nemění, jen to nabídne ve Správě — tahle notifikace o tom dá vědět hned.
   ========================================================= */
exports.onVideoAutoCheck = onDocumentUpdated("videos/{videoId}", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  if (jeObnova(before, after)) return;
  const a = after.autoCheck, b = before.autoCheck;
  if (!a || !a.result) return;
  if (b && b.result === a.result && b.at === a.at) return;

  const nazev = after.title || "video";
  await notifikuj(ADMIN_UID, {
    type: "autoCheck",
    title: "Trenér — kontrola videí",
    body: a.result === "missing"
      ? `Video „${nazev}“ u zdroje nejspíš zmizelo.`
      : `Video „${nazev}“ u zdroje zase existuje.`,
    url: `${APP_URL}?open=sprava`
  });
});

/* =========================================================
   ZKUŠEBNÍ NOTIFIKACE — tlačítko v appce (profil → Notifikace).
   Schválně onCall, ne veřejná adresa: volání musí být přihlášené a pustí se jen adminovi.
   Noční klid ani tlumení se tady neuplatní, jinak by tlačítko občas „nefungovalo“.
   ========================================================= */
exports.sendTestNotification = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("permission-denied", "Zkušební notifikaci pošle jen přihlášený trenér.");
  }
  const prefs = await nastaveni(uid);
  if (!prefs.tokens.length) {
    throw new HttpsError("failed-precondition", "Tenhle účet nemá uložené žádné zařízení.");
  }
  /* Vrací se skutečná odpověď od FCM, ne jen počet uložených zařízení (24. 9. 2026).
     Do té doby appka hlásila „odesláno“ i ve chvíli, kdy FCM všechno odmítl. */
  const vysledek = await posli(uid, prefs.tokens, {
    title: "Trenér — zkouška",
    body: "Notifikace fungují. Ťukni a otevře se appka.",
    url: APP_URL,
    type: "test"
  });
  return { sent: prefs.tokens.length, ok: vysledek.ok, fail: vysledek.fail, kody: vysledek.kody };
});