const CACHE_NAME = "trener-v7";
const APP_SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./club-logo.png", "./raptor-sound.mp3"];

/* =========================================================
   PUSH NOTIFIKACE (Firebase Cloud Messaging) — tahle část stará
   se jen o notifikace, které přijdou, když appka NENÍ zrovna
   otevřená/aktivní na obrazovce (proto žije v service workeru,
   ne v index.html). Odesílá je Cloud Function na serveru.
   ========================================================= */
importScripts("https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyDHEDRx6jJAE1-0fvTmaMetlh4w6CeTREY",
  authDomain: "trener-6d1b2.firebaseapp.com",
  projectId: "trener-6d1b2",
  storageBucket: "trener-6d1b2.firebasestorage.app",
  messagingSenderId: "796712714371",
  appId: "1:796712714371:web:740d1c4c73f9319f509bb6"
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "Trenér";
  const options = {
    body: (payload.notification && payload.notification.body) || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    vibrate: [80, 40, 80],
    data: payload.data || {}
  };
  self.registration.showNotification(title, options);
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes("index.html") || c.url.endsWith("/"));
      if (existing) return existing.focus();
      return self.clients.openWindow("./index.html");
    })
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Cizí domény (Firebase, YouTube, Google Fonts, Disk...) necháváme jít přímo na síť.
  if (url.origin !== location.origin) return;

  // Appka samotná (shell): napřed vždycky zkusit síť, ať appka nezůstává tiše na staré verzi.
  // Uložená verze slouží jen jako záchranná síť, když appka fakt nemá signál.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
