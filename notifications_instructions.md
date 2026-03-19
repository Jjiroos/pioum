# Instructions — Feature Push Notifications Pioum

## Contexte du projet

Pioum est une web application React (PWA) de covoiturage pour des sessions sportives en groupe.
Elle est développée en **TypeScript strict** avec un monorepo structuré comme suit :

```
packages/
├── backend/    → API REST Express + Node.js
└── frontend/   → React + Vite (PWA installable)
```

L'objectif de cette feature est de notifier un utilisateur en temps réel lorsqu'un participant
s'inscrit à une séance et d'indiquer s'il dispose ou non d'une voiture.

---

## Stack technique

| Couche | Technologie |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Backend | Node.js 20+, Express, TypeScript |
| Push | `@pushforge/builder` (zéro dépendance, Web Crypto API) |
| Package manager | pnpm (monorepo) |

> ⚠️ **Ne jamais utiliser `web-push`** — cette bibliothèque est dépréciée et introduit des
> sous-dépendances obsolètes. Utiliser exclusivement `@pushforge/builder`.

---

## Architecture

```
[PWA installée iPhone/Android]
        │
        ▼
[Frontend React]
  ├── registerServiceWorker()   → enregistrement au démarrage (App.tsx)
  ├── usePushNotifications()    → hook React (abonnement sur action utilisateur)
  └── <NotificationBell />      → composant UI déclencheur
        │
        ▼
[Backend Express]
  ├── POST /api/notifications/subscribe     → sauvegarde subscription
  ├── POST /api/notifications/unsubscribe   → supprime subscription
  └── notifyUser()                          → envoi push via @pushforge/builder
        │
        ▼
[Service Worker — public/sw.ts]
  ├── 'push' event      → affiche la notification système
  └── 'notificationclick' → ouvre l'app sur la bonne URL
```

---

## Variables d'environnement requises

Générer les clés **une seule fois** avec :
```bash
npx @pushforge/builder vapid
```
> Ne jamais régénérer les clés en production sans migrer les subscriptions existantes.

### `packages/backend/.env`
```env
VAPID_PUBLIC_KEY=<base64url>
VAPID_PRIVATE_KEY_JWK={"alg":"ES256","key_ops":["sign"],"ext":true,"kty":"EC",...}
VAPID_EMAIL=mailto:contact@pioum.fr
```

### `packages/frontend/.env`
```env
VITE_VAPID_PUBLIC_KEY=<même base64url que VAPID_PUBLIC_KEY>
```

> Le fichier `.env` doit être dans `.gitignore`. Ne jamais commiter de secrets.

---

## Fichiers à créer

### `packages/backend/src/notifications/notification.service.ts`

```typescript
import { buildPushHTTPRequest } from '@pushforge/builder';

export type WebPushSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type PioumNotificationPayload = {
  title: string;
  body: string;
  url: string;
  type: 'NEW_INSCRIPTION' | 'CAR_AVAILABLE' | 'NO_CAR';
};

// À remplacer par le repository/ORM du projet (Prisma, etc.) — jamais un Map en production
const subscriptions = new Map<string, WebPushSubscription>();

export function saveSubscription(userId: string, sub: WebPushSubscription): void {
  subscriptions.set(userId, sub);
}

export function removeSubscription(userId: string): void {
  subscriptions.delete(userId);
}

export function getSubscription(userId: string): WebPushSubscription | undefined {
  return subscriptions.get(userId);
}

export async function notifyUser(
  userId: string,
  payload: PioumNotificationPayload
): Promise<void> {
  const sub = subscriptions.get(userId);
  if (!sub) return;

  // Clé privée lue depuis l'environnement uniquement — jamais en dur dans le code
  const privateJWK = JSON.parse(process.env.VAPID_PRIVATE_KEY_JWK!);

  const { endpoint, headers, body } = await buildPushHTTPRequest({
    privateJWK,
    subscription: sub,
    message: {
      payload: JSON.stringify(payload),
      options: {
        ttl: 3600,        // notification valable 1h si l'utilisateur est offline
        urgency: 'normal',
        topic: 'pioum-session', // évite les doublons de notifications
      },
      adminContact: process.env.VAPID_EMAIL!,
    },
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
  });

  // Subscription expirée → suppression immédiate sans propager l'erreur
  if (response.status === 410) {
    removeSubscription(userId);
    return;
  }

  if (!response.ok) {
    throw new Error(`Push failed: ${response.status} ${await response.text()}`);
  }
}
```

---

### `packages/backend/src/notifications/notification.controller.ts`

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import {
  saveSubscription,
  removeSubscription,
  notifyUser,
  WebPushSubscription,
} from './notification.service';

const router = Router();

// --- Interfaces de typage des bodies ---

interface SubscribeBody {
  subscription: WebPushSubscription;
  userId: string;
}

interface UnsubscribeBody {
  userId: string;
}

interface SendInscriptionBody {
  organizerId: string;
  participantName: string;
  hasCar: boolean;
}

// --- Middleware de validation ---

function validateBody(fields: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const missing = fields.filter((f) => req.body[f] === undefined);
    if (missing.length > 0) {
      res.status(400).json({ error: `Champs manquants : ${missing.join(', ')}` });
      return;
    }
    next();
  };
}

// --- Routes ---

// Appelée par le frontend après l'abonnement push de l'utilisateur
router.post(
  '/subscribe',
  validateBody(['subscription', 'userId']),
  (req: Request<object, object, SubscribeBody>, res: Response): void => {
    const { subscription, userId } = req.body;
    saveSubscription(userId, subscription);
    res.status(201).json({ message: 'Abonnement enregistré' });
  }
);

router.post(
  '/unsubscribe',
  validateBody(['userId']),
  (req: Request<object, object, UnsubscribeBody>, res: Response): void => {
    const { userId } = req.body;
    removeSubscription(userId);
    res.status(200).json({ message: 'Désabonnement effectué' });
  }
);

// ⚠️ Route de test uniquement — en production, notifyUser() est appelé
// directement depuis SessionService, pas via cette route HTTP
router.post(
  '/send-inscription',
  validateBody(['organizerId', 'participantName', 'hasCar']),
  async (
    req: Request<object, object, SendInscriptionBody>,
    res: Response
  ): Promise<void> => {
    const { organizerId, participantName, hasCar } = req.body;
    try {
      await notifyUser(organizerId, {
        title: '🚗 Nouvelle inscription Pioum',
        body: `${participantName} ${hasCar ? 'a une voiture 🚗' : "n'a pas de voiture ❌"}`,
        url: '/sessions',
        type: hasCar ? 'CAR_AVAILABLE' : 'NO_CAR',
      });
      res.json({ sent: true });
    } catch (err) {
      // Ne jamais exposer le détail de l'erreur interne au client
      console.error('[Pioum] Erreur envoi push:', err);
      res.status(500).json({ error: "Échec de l'envoi de la notification" });
    }
  }
);

export default router;
```

---

### Branchement dans `packages/backend/src/app.ts`

```typescript
import notificationRouter from './notifications/notification.controller';

// Ajouter cette ligne avec les autres routes
app.use('/api/notifications', notificationRouter);
```

---

### `packages/frontend/public/sw.ts`

```typescript
/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

// Reçoit le push depuis le backend et affiche la notification système
self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;

  const data = event.data.json() as {
    title: string;
    body: string;
    url?: string;
    type?: 'NEW_INSCRIPTION' | 'CAR_AVAILABLE' | 'NO_CAR';
  };

  const iconMap: Record<string, string> = {
    NEW_INSCRIPTION: '/icons/person.png',
    CAR_AVAILABLE: '/icons/car.png',
    NO_CAR: '/icons/no-car.png',
  };

  const icon = data.type ? (iconMap[data.type] ?? '/logo192.png') : '/logo192.png';

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon,
      badge: '/logo72.png',
      vibrate: ,
      data: { url: data.url ?? '/' },
    })
  );
});

// Clic sur la notification → ouvre ou focus la bonne page de l'app
self.addEventListener('notificationclick', (event: NotificationClickEvent) => {
  event.notification.close();
  const targetUrl = (event.notification.data?.url as string) ?? '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url === targetUrl && 'focus' in client) return client.focus();
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});

// Permet la mise à jour instantanée du Service Worker
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
```

---

### `packages/frontend/src/services/pushNotification.service.ts`

```typescript
// Clé publique VAPID lue depuis les variables d'environnement Vite — jamais en dur
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;

// Conversion base64url → Uint8Array requise par l'API pushManager.subscribe()
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Workers non supportés sur ce navigateur');
  }
  return navigator.serviceWorker.register('/sw.js');
}

export async function subscribeToPush(
  registration: ServiceWorkerRegistration
): Promise<PushSubscription> {
  // Retourne l'abonnement existant s'il y en a un pour éviter les doublons
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  return registration.pushManager.subscribe({
    userVisibleOnly: true, // obligatoire — les push silencieux sont interdits
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
}

export async function sendSubscriptionToServer(
  subscription: PushSubscription,
  userId: string
): Promise<void> {
  const res = await fetch('/api/notifications/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, userId }),
  });
  if (!res.ok) throw new Error('Erreur enregistrement subscription');
}

export async function unsubscribeFromPush(userId: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sub.unsubscribe();
    await fetch('/api/notifications/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
  }
}
```

---

### `packages/frontend/src/hooks/usePushNotifications.ts`

```typescript
import { useState, useEffect } from 'react';
import {
  registerServiceWorker,
  subscribeToPush,
  sendSubscriptionToServer,
  unsubscribeFromPush,
} from '../services/pushNotification.service';

type PushState = {
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
  permission: NotificationPermission;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
};

export function usePushNotifications(userId: string): PushState {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>('default');

  useEffect(() => {
    if ('Notification' in window) setPermission(Notification.permission);
  }, []);

  const subscribe = async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const registration = await registerServiceWorker();
      const subscription = await subscribeToPush(registration);
      await sendSubscriptionToServer(subscription, userId);
      setIsSubscribed(true);
      setPermission('granted');
    } catch (err) {
      setError("Impossible d'activer les notifications");
      console.error('[Pioum] Erreur abonnement push:', err);
    } finally {
      // Garantit la remise à false même en cas d'erreur
      setIsLoading(false);
    }
  };

  const unsubscribe = async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      await unsubscribeFromPush(userId);
      setIsSubscribed(false);
    } catch (err) {
      setError('Impossible de désactiver les notifications');
      console.error('[Pioum] Erreur désabonnement push:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return { isSubscribed, isLoading, error, permission, subscribe, unsubscribe };
}
```

---

### `packages/frontend/src/components/NotificationBell.tsx`

```tsx
import { usePushNotifications } from '../hooks/usePushNotifications';

interface Props {
  userId: string;
}

export function NotificationBell({ userId }: Props) {
  const { isSubscribed, isLoading, error, permission, subscribe, unsubscribe } =
    usePushNotifications(userId);

  // Navigateur non compatible (ex: Safari sans PWA installée)
  if (!('Notification' in window)) return null;

  if (permission === 'denied') {
    return (
      <p className="text-sm text-red-500">
        🔕 Notifications bloquées — modifie les réglages de ton navigateur
      </p>
    );
  }

  return (
    <div>
      <button
        onClick={isSubscribed ? unsubscribe : subscribe}
        disabled={isLoading}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50"
      >
        {isLoading
          ? '...'
          : isSubscribed
          ? '🔕 Désactiver les notifications'
          : '🔔 Activer les notifications'}
      </button>
      {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
    </div>
  );
}
```

---

### `packages/frontend/src/App.tsx` — modification requise

```tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuthStore } from './stores/auth'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/LoginPage'
import { VerifyPage } from './pages/VerifyPage'
import { HomePage } from './pages/HomePage'
import { GroupPage } from './pages/GroupPage'
import { SessionPage } from './pages/SessionPage'
import { ProfilePage } from './pages/ProfilePage'
import { JoinGroupPage } from './pages/JoinGroupPage'
import { CreateGroupPage } from './pages/CreateGroupPage'
import { BansPage } from './pages/BansPage'
import { LoadingSpinner } from './components/LoadingSpinner'
import { registerServiceWorker } from './services/pushNotification.service'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function App() {
  const { checkAuth, loading } = useAuthStore()

  useEffect(() => {
    checkAuth()
    // Enregistre le Service Worker au démarrage — silencieux, sans popup
    // L'abonnement push réel est déclenché uniquement via <NotificationBell />
    registerServiceWorker().catch((err) => {
      console.warn('[Pioum] Service Worker non enregistré:', err)
    })
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/verify" element={<VerifyPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/groups/create" element={<CreateGroupPage />} />
                <Route path="/groups/join" element={<JoinGroupPage />} />
                <Route path="/groups/:groupId" element={<GroupPage />} />
                <Route path="/sessions/:sessionId" element={<SessionPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/bans" element={<BansPage />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default App
```

---

## Flux métier : nouvelle inscription à une séance

```
1. Participant  →  POST /api/sessions/:id/join
2. SessionService enregistre l'inscription en base
3. SessionService appelle notifyUser(organizerId, payload)   ← point d'intégration
4. notifyUser() construit la requête via @pushforge/builder
5. fetch() envoie au Push Service (Apple/Google)
6. Service Worker reçoit l'événement 'push'
7. showNotification() affiche la notification sur l'iPhone de l'organisateur
```

> `notifyUser()` doit être intégré à l'étape 3 dans le `SessionService` existant,
> jamais appelé depuis le `notification.controller.ts` en production.

---

## Compatibilité iOS

- Push notifications PWA disponibles sur **iOS 16.4+** uniquement, via Safari
- L'utilisateur **doit avoir installé la PWA** via "Ajouter à l'écran d'accueil"
- Ne pas afficher `<NotificationBell />` si la PWA n'est pas installée :

```typescript
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
```

- Afficher des instructions d'installation si `!isStandalone` dans Safari

---

## Règles de qualité et sécurité

### TypeScript
- `strict: true` obligatoire dans `tsconfig.json`
- Aucun `any` explicite ou implicite
- Tous les `req.body` Express typés via `Request<object, object, BodyType>`
- Tous les hooks React avec un type de retour explicite

### Sécurité
- `VAPID_PRIVATE_KEY_JWK` accessible côté backend uniquement
- Ne jamais logger les clés privées, subscriptions complètes, ni endpoints utilisateurs
- Valider tous les inputs des routes Express avant tout traitement
- Supprimer les subscriptions expirées (HTTP 410) sans propager l'erreur au client
- Valider que `hasCar` est un `boolean`, pas une string `"true"/"false"`

### Gestion d'erreurs
- Toutes les routes `async` Express ont un `try/catch`
- Toutes les `Promise` front non rattachées à un state React ont un `.catch()`
- Les erreurs internes ne sont jamais exposées au client (message générique en `500`)

---

## Débogage & corrections apportées (session 2026-03-19)

### Bug : table `PushSubscription` absente en base

**Symptôme** :
```
ERROR: relation "public.PushSubscription" does not exist
Invalid `prisma.pushSubscription.findUnique()` invocation
```

**Cause** : le modèle `PushSubscription` avait été ajouté dans `schema.prisma` mais
`pnpm db:push` n'avait jamais été relancé. La table n'existait donc pas en base.

**Fix** : depuis `packages/backend` (ou la racine du monorepo) :
```bash
pnpm db:push      # synchronise le schéma avec la DB
pnpm db:generate  # regénère les types TypeScript Prisma
```

> ⚠️ Ce projet utilise **`prisma db push`**, pas `prisma migrate`.
> Ne pas créer de fichiers de migration manuels dans `prisma/migrations/`.
> La documentation de référence est `DOCUMENTATION.md` → section "Workflow Prisma".

---

### Différence entre la version initiale et la version finale du service

Le fichier `notification.service.ts` décrit dans la section précédente de ce document
utilisait un `Map` en mémoire pour stocker les subscriptions.
La version réelle en production utilise **Prisma** (`prisma.pushSubscription`) :

```typescript
// ✅ Version Prisma (production) — packages/backend/src/notifications/notification.service.ts
await prisma.pushSubscription.upsert({ where: { userId }, update: {...}, create: {...} })
await prisma.pushSubscription.deleteMany({ where: { userId } })
await prisma.pushSubscription.findUnique({ where: { userId } })
```

Le modèle Prisma :
```prisma
model PushSubscription {
  id        String   @id @default(cuid())
  userId    String   @unique
  endpoint  String
  p256dh    String
  auth      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

---

### Tests ajoutés

**Fichiers créés** :
- `packages/backend/src/notifications/notification.service.test.ts` (11 tests)
- `packages/backend/src/notifications/notification.controller.test.ts` (9 tests)

**Framework** : Vitest (déjà utilisé dans le projet). Lancer avec :
```bash
cd packages/backend
npx vitest run src/notifications/
```

**Pattern utilisé** : identique à `src/routes/bans.test.ts` — Prisma entièrement mocké
avec `vi.mock('../lib/prisma.js', ...)`, `@pushforge/builder` mocké, `fetch` mocké via
`vi.stubGlobal('fetch', ...)`.

**Ce que les tests couvrent** :

`notification.service.test.ts` :
- `saveSubscription` → upsert correct, propagation des erreurs DB
- `removeSubscription` → deleteMany appelé, pas d'erreur si aucune sub
- `notifyUser` → retour immédiat si pas de sub, envoi correct, suppression auto sur HTTP 410, throw sur 5xx
- `notifyGroupMembers` → broadcast à tous sauf l'exclu, résistance aux échecs partiels, groupe vide

`notification.controller.test.ts` :
- `POST /subscribe` → 201 OK, 400 si champ manquant, erreur DB → next()
- `POST /unsubscribe` → 200 OK, erreur DB → next()
- `GET /vapid-public-key` → clé retournée, 503 si env var absente

