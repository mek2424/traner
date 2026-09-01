/**
 * Cloud Functions pro appku Trenér.
 *
 * Appka (index.html) sama neumí poslat notifikaci, když je zavřená nebo telefon
 * zamčený — na to je potřeba tenhle kousek serverového kódu, který běží na
 * Firebase a hlídá si Firestore. Když se něco stane, pošle push notifikaci
 * adminovi (jen jemu — je to natvrdo omezené na ADMIN_UID níž) přes Firebase
 * Cloud Messaging, na všechna zařízení, která si u sebe uložila token
 * (viz #adminNotifySection a ensureMessaging() v index.html).
 *
 * NASAZENÍ (musíš udělat sám/sama, viz návod, který ti Claude poslal v chatu):
 *   cd functions && npm install
 *   firebase deploy --only functions
 */
const { onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Frankfurt — nejbližší region k ČR, funkce v něm poběží o něco rychleji.
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

// Stejné UID jako ADMIN_UID v index.html (const ADMIN_UID = "...") — notifikace
// jsou natvrdo jen pro tenhle účet, nikdo jiný token uložit nemůže (appka mu tu
// sekci v profilu vůbec nezobrazí).
const ADMIN_UID = "WIw1KfRofOOrbYF7Xl8YzgQrTZd2";

// Po jaké době neaktivity se další "objevení" bere jako nový příchod (a ne jen
// další heartbeat tik, co appka posílá každých pár desítek vteřin, dokud je
// otevřená — viz ONLINE_THRESHOLD_MS/beat() v index.html).
const ONLINE_AWAY_MS = 60 * 60 * 1000; // 1 hodina

async function getAdminPrefs() {
  const snap = await db.collection("users").doc(ADMIN_UID).get();
  const d = snap.exists ? snap.data() : {};
  return {
    enabled: !!d.notifyPushEnabled,
    tokens: Array.isArray(d.fcmTokens) ? d.fcmTokens : [],
    pref: d.notifyPref || "major",
    notifyOnline: d.notifyOnline !== false
  };
}

async function getDisplayName(uid) {
  if (!uid) return "Někdo";
  try {
    const snap = await db.collection("users").doc(uid).get();
    const d = snap.exists ? snap.data() : {};
    return d.username || "Trenér";
  } catch (e) {
    return "Trenér";
  }
}

async function sendToAdmin(tokens, title, body, data) {
  if (!tokens.length) return;
  const resp = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: data || {}
  });
  // Průběžný úklid: token, co appka/prohlížeč zneplatnily (odhlášení, smazaná data
  // prohlížeče, přeinstalace...), radši hned zahodit, ať se seznam nenafukuje mrtvými
  // záznamy a příští odesílání zbytečně nečeká na jistá selhání.
  const deadTokens = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        deadTokens.push(tokens[i]);
      }
    }
  });
  if (deadTokens.length) {
    await db.collection("users").doc(ADMIN_UID).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...deadTokens)
    });
  }
}

/**
 * 1) Změny ve sdílené knihovně (videa, složky, štítky, vybavení).
 * Celá knihovna se ukládá do jednoho dokumentu shared/data (viz saveUserData()
 * v index.html) — appka do něj při každém uložení zapisuje i lastEditedBy/
 * lastEditedAt, podle čeho tahle funkce pozná, kdo změnu udělal (a přeskočí
 * adminovy vlastní změny, aby mu nechodily notifikace sám na sebe).
 */
exports.onSharedDataChange = onDocumentUpdated("shared/data", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const editorUid = after.lastEditedBy;
  if (!editorUid || editorUid === ADMIN_UID) return;

  const prefs = await getAdminPrefs();
  if (!prefs.enabled || !prefs.tokens.length) return;

  const beforeVideoCount = Object.keys(before.library || {}).length;
  const afterVideoCount = Object.keys(after.library || {}).length;
  const beforeFolderCount = (before.folders || []).length;
  const afterFolderCount = (after.folders || []).length;
  const beforeTagCount = (before.tagPool || []).length;
  const afterTagCount = (after.tagPool || []).length;
  const beforeEquipCount = (before.equipmentPool || []).length;
  const afterEquipCount = (after.equipmentPool || []).length;

  const majorParts = [];
  if (afterVideoCount > beforeVideoCount) majorParts.push(`přidal(a) ${afterVideoCount - beforeVideoCount} video${afterVideoCount - beforeVideoCount === 1 ? "" : "a"}`);
  else if (afterVideoCount < beforeVideoCount) majorParts.push(`smazal(a) ${beforeVideoCount - afterVideoCount} video${beforeVideoCount - afterVideoCount === 1 ? "" : "a"}`);
  if (afterFolderCount > beforeFolderCount) majorParts.push("přidal(a) složku");
  else if (afterFolderCount < beforeFolderCount) majorParts.push("smazal(a) složku");
  if (afterTagCount > beforeTagCount) majorParts.push("přidal(a) nový štítek");
  if (afterEquipCount > beforeEquipCount) majorParts.push("přidal(a) nové vybavení");

  const isMajor = majorParts.length > 0;
  if (prefs.pref === "major" && !isMajor) return;

  const name = await getDisplayName(editorUid);
  const body = isMajor ? majorParts.join(", ") : "upravil(a) knihovnu (detail, popis nebo pořadí)";
  await sendToAdmin(prefs.tokens, "Trenér — změna v knihovně", `${name} ${body}.`, { type: "library-change" });
});

/**
 * 2) Tréninky ostatních trenérů (každý trenér má vlastní podkolekci
 * users/{uid}/trainings/{id} — {uid} je zástupný znak, takže tenhle trigger
 * chytá zápisy od VŠECH trenérů, admina samotného schválně přeskočí.
 */
exports.onTrainingChange = onDocumentWritten("users/{uid}/trainings/{trainingId}", async (event) => {
  const uid = event.params.uid;
  if (uid === ADMIN_UID) return;

  const prefs = await getAdminPrefs();
  if (!prefs.enabled || !prefs.tokens.length) return;

  const beforeExists = event.data.before.exists;
  const afterExists = event.data.after.exists;
  const isMajor = !beforeExists || !afterExists; // vytvoření nebo smazání (ne jen úprava)
  if (prefs.pref === "major" && !isMajor) return;

  const src = afterExists ? event.data.after.data() : (event.data.before.data() || {});
  const trainingName = src.name || "trénink";
  const name = await getDisplayName(uid);
  let action;
  if (!beforeExists) action = `vytvořil(a) nový trénink „${trainingName}“`;
  else if (!afterExists) action = `smazal(a) trénink „${trainingName}“`;
  else action = `upravil(a) trénink „${trainingName}“`;

  await sendToAdmin(prefs.tokens, "Trenér — trénink", `${name} ${action}.`, { type: "training-change" });
});

/**
 * 3) Někdo přišel online. Appka každých pár desítek vteřin, dokud je otevřená,
 * zapisuje aktuální čas do users/{uid}.heartbeatAt (viz beat() v index.html).
 * Aby notifikace nechodila při každém tiku, posílá se jen když je mezera od
 * předchozího heartbeatu delší než ONLINE_AWAY_MS (tj. člen byl fakt pryč, ne
 * jen že appka zrovna zapsala další pravidelný tik).
 */
exports.onUserHeartbeat = onDocumentWritten("users/{uid}", async (event) => {
  const uid = event.params.uid;
  if (uid === ADMIN_UID) return;
  if (!event.data.after.exists) return; // smazání účtu nás tady nezajímá

  const before = event.data.before.exists ? (event.data.before.data() || {}) : {};
  const after = event.data.after.data() || {};
  if (!after.heartbeatAt || after.heartbeatAt === before.heartbeatAt) return;

  const wasAway = !before.heartbeatAt || (after.heartbeatAt - before.heartbeatAt) > ONLINE_AWAY_MS;
  if (!wasAway) return;

  const prefs = await getAdminPrefs();
  if (!prefs.enabled || !prefs.tokens.length || !prefs.notifyOnline) return;

  const name = after.username || before.username || "Trenér";
  await sendToAdmin(prefs.tokens, "Trenér — online", `${name} je právě online.`, { type: "presence" });
});
