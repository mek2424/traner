/**
 * Cloud Functions pro appku Trenér — notifikace pro admina (fáze 1, 23. 9. 2026).
 *
 * Appka sama neumí poslat notifikaci, když je zavřená nebo je telefon zamčený — na to je
 * potřeba tenhle serverový kousek, který hlídá Firestore a posílá push přes Firebase Cloud
 * Messaging. Posílá se JEN adminovi (natvrdo ADMIN_UID níž), na všechna zařízení, která si
 * uložil (users/{ADMIN_UID}.fcmTokens — ukládá je appka, viz zapniNotifikace v index.html).
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
  videoDeleted: "library",   // smazané video (zvlášť, je to nevratné)
  training: "library",       // tréninky ostatních
  trainingCloned: "library", // někdo si zkopíroval Mekův trénink
  access: "people",          // žádost o přístup
  online: "people",          // první příchod trenéra za den
  tip: "videos",             // tip na video od prohlížeče
  comment: "videos",         // komentáře a zmínky
  goneReport: "videos",      // hlášení „video zmizelo u zdroje“
  autoCheck: "videos"        // nález automatické kontroly videí
};

/** České množné číslo bez psaní „1 změn(a)“. */
function pocet(n, jedna, dve, pet) {
  return n === 1 ? `1 ${jedna}` : (n >= 2 && n <= 4 ? `${n} ${dve}` : `${n} ${pet}`);
}

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

async function adminNastaveni() {
  const snap = await db.collection("users").doc(ADMIN_UID).get();
  const d = snap.exists ? snap.data() : {};
  const g = d.notifyGroups || {};
  return {
    enabled: !!d.notifyPushEnabled,
    tokens: Array.isArray(d.fcmTokens) ? d.fcmTokens : [],
    // Chybějící skupina = zapnutá. Vypnutá je jen ta, u které je výslovně false.
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
async function posliAdminovi(tokens, { title, body, url, type }) {
  if (!tokens.length) return;
  const resp = await messaging.sendEachForMulticast({
    tokens,
    data: { title, body, url: url || APP_URL, type: type || "", icon: ICON_URL },
    webpush: { headers: { Urgency: "normal", TTL: "86400" } }
  });
  const mrtve = [];
  resp.responses.forEach((r, i) => {
    const code = r.success ? null : (r.error && r.error.code);
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
      mrtve.push(tokens[i]);
    }
  });
  if (mrtve.length) {
    await db.collection("users").doc(ADMIN_UID).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...mrtve)
    });
  }
}

/**
 * Jediná cesta ven. Postupně: zapnuto? je komu? není skupina vypnutá? není noční klid?
 * a nakonec tlumení podle typu — když stejný typ odešel před méně než deseti minutami,
 * událost se jen připočte a text se přilepí k nejbližší další hlášce téhož typu.
 */
async function notifikuj({ type, title, body, url, key }) {
  const prefs = await adminNastaveni();
  if (!prefs.enabled || !prefs.tokens.length) return;
  if (prefs.groups[TYPE_GROUP[type] || "library"] === false) return;
  if (jeNocniKlid()) return;

  /* Klíč tlumení je normálně typ. Výjimka je „někdo je online“: tam se tlumí zvlášť pro
     každého trenéra (key = online:uid), jinak by se při dvou příchodech za sebou ztratilo
     jméno toho druhého. Že to nezahltí, hlídá už pravidlo „jednou denně na trenéra“. */
  const stavKlic = key || type;
  const ref = db.collection("notifyState").doc("admin");
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
  await posliAdminovi(prefs.tokens, { title, body: body + dovetek, url, type });
}

/* =========================================================
   1) SDÍLENÁ KNIHOVNA (videa, složky, štítky, vybavení)
   Celá knihovna je jeden dokument shared/data, do kterého appka při každém uložení píše
   i lastEditedBy — podle toho se pozná, kdo změnu udělal, a Mekovy vlastní změny se
   přeskočí. Mazání videa má vlastní typ: je to jediná nevratná věc, kterou editor dělá.
   ========================================================= */
exports.onSharedDataChange = onDocumentUpdated("shared/data", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const editorUid = after.lastEditedBy;
  if (!editorUid || editorUid === ADMIN_UID) return;

  const libBefore = before.library || {};
  const libAfter = after.library || {};
  const zivy = (o) => Object.keys(o).filter(id => o[id] && !o[id].deletedAt);

  const predtim = zivy(libBefore);
  const potom = zivy(libAfter);
  const pribylo = potom.filter(id => !predtim.includes(id));
  const ubylo = predtim.filter(id => !potom.includes(id));

  const kdo = await jmeno(editorUid);

  if (ubylo.length) {
    const nazvy = ubylo.slice(0, 2).map(id => `„${(libBefore[id] && libBefore[id].title) || "bez názvu"}“`).join(", ");
    const zbytek = ubylo.length > 2 ? ` a ${pocet(ubylo.length - 2, "další", "další", "dalších")}` : "";
    await notifikuj({
      type: "videoDeleted",
      title: "Trenér — smazané video",
      body: `${kdo} smazal(a) ${nazvy}${zbytek}.`,
      url: APP_URL
    });
  }

  const casti = [];
  if (pribylo.length) casti.push(`přidal(a) ${pocet(pribylo.length, "video", "videa", "videí")}`);
  const delta = (a, b) => (b || []).length - (a || []).length;
  const dSlozky = delta(before.folders, after.folders);
  const dStitky = delta(before.tagPool, after.tagPool);
  const dVybaveni = delta(before.equipmentPool, after.equipmentPool);
  if (dSlozky > 0) casti.push("přidal(a) složku");
  else if (dSlozky < 0) casti.push("smazal(a) složku");
  if (dStitky > 0) casti.push("přidal(a) nový štítek");
  if (dVybaveni > 0) casti.push("přidal(a) nové vybavení");

  if (!casti.length) {
    if (ubylo.length) return;   // mazání už odešlo výš, druhou hlášku o tomtéž neposíláme
    casti.push("upravil(a) knihovnu (popis, štítky nebo pořadí)");
  }
  await notifikuj({
    type: "library",
    title: "Trenér — změna v knihovně",
    body: `${kdo} ${casti.join(", ")}.`,
    url: APP_URL
  });
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
  const src = je ? event.data.after.data() : (event.data.before.data() || {});
  const nazev = src.name || "trénink";
  const kdo = await jmeno(uid);
  const url = `${APP_URL}?open=training&u=${encodeURIComponent(uid)}&id=${encodeURIComponent(event.params.trainingId)}`;

  if (!bylo && je && src.clonedFromOwnerUid === ADMIN_UID) {
    await notifikuj({
      type: "trainingCloned",
      title: "Trenér — kopie tvého tréninku",
      body: `${kdo} si zkopíroval(a) tvůj trénink „${src.clonedFromName || nazev}“.`,
      url
    });
    return;
  }

  let co;
  if (!bylo) co = `vytvořil(a) nový trénink „${nazev}“`;
  else if (!je) co = `smazal(a) trénink „${nazev}“`;
  else co = `upravil(a) trénink „${nazev}“`;
  await notifikuj({ type: "training", title: "Trenér — trénink", body: `${kdo} ${co}.`, url: je ? url : APP_URL });
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
  await notifikuj({ type: "online", key: `online:${uid}`, title: "Trenér — online", body: `${kdo} je dneska poprvé v appce.`, url: APP_URL });
});

/* =========================================================
   4) ŽÁDOST O PŘÍSTUP — nový účet čeká na schválení.
   ========================================================= */
exports.onAccessRequest = onDocumentCreated("pendingRequests/{uid}", async (event) => {
  const d = (event.data && event.data.data()) || {};
  if (event.params.uid === ADMIN_UID) return;
  await notifikuj({
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
  if (!d.fromUid || d.fromUid === ADMIN_UID) return;
  const kdo = d.fromLabel || await jmeno(d.fromUid);
  await notifikuj({
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
  if (!d.authorUid || d.authorUid === ADMIN_UID) return;
  if (d.isBrokenReport) return;
  if (d.goneEvent === "retract") return;   // stažené hlášení: počet ve Správě se sníží sám

  const nazev = d.videoTitle || "video";
  const url = d.videoId ? `${APP_URL}?open=video&id=${encodeURIComponent(d.videoId)}` : APP_URL;

  if (d.isGoneReport || d.goneEvent === "report") {
    await notifikuj({
      type: "goneReport",
      title: "Trenér — nahlášené video",
      body: `${d.authorLabel || "Trenér"}: „${nazev}“ nejde přehrát ani u zdroje.`,
      url
    });
    return;
  }

  const zminka = Array.isArray(d.mentions) && d.mentions.includes(ADMIN_UID);
  await notifikuj({
    type: "comment",
    title: zminka ? "Trenér — zmínka v komentáři" : "Trenér — nový komentář",
    body: `${d.authorLabel || "Trenér"} u „${nazev}“: ${(d.text || "").slice(0, 120)}`,
    url
  });
});

/* =========================================================
   7) NÁLEZ AUTOMATICKÉ KONTROLY VIDEÍ.
   Appka kontrolu pouští u admina po přihlášení a nález si ukládá do videos/{id}.autoCheck.
   Sama nic nemění, jen to nabídne ve Správě — tahle notifikace o tom dá vědět hned.
   ========================================================= */
exports.onVideoAutoCheck = onDocumentUpdated("videos/{videoId}", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const a = after.autoCheck, b = before.autoCheck;
  if (!a || !a.result) return;
  if (b && b.result === a.result && b.at === a.at) return;

  const nazev = after.title || "video";
  await notifikuj({
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
  if (!request.auth || request.auth.uid !== ADMIN_UID) {
    throw new HttpsError("permission-denied", "Zkušební notifikaci může poslat jen admin.");
  }
  const prefs = await adminNastaveni();
  if (!prefs.tokens.length) {
    throw new HttpsError("failed-precondition", "Tenhle účet nemá uložené žádné zařízení.");
  }
  await posliAdminovi(prefs.tokens, {
    title: "Trenér — zkouška",
    body: "Notifikace fungují. Ťukni a otevře se appka.",
    url: APP_URL,
    type: "test"
  });
  return { sent: prefs.tokens.length };
});