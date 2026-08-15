// Modular subpath imports, not the `import admin from 'firebase-admin'` namespace style:
// firebase-admin v13 ships its types only on the subpaths, and the namespace form does not
// typecheck under this project's ESM/NodeNext resolution.
import { cert, getApps, getApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging, type SendResponse } from 'firebase-admin/messaging';
import { DateTime } from 'luxon';
import { Business, OrderRating, PushSubscription } from '../models.js';

/**
 * Web push to customers, over Firebase Cloud Messaging.
 *
 * This complements the WhatsApp messages rather than replacing them: those are composed here
 * but sent by hand by a staff member (services/whatsapp.ts), whereas these fire automatically
 * from the order write itself. A customer opts in once, from the link carried in their
 * order-created WhatsApp message, and is then notified of every status change without anyone
 * at the shop doing anything.
 *
 * Two things about the payload shape are deliberate and worth not "simplifying" later:
 *
 *  1. Every message is **data-only** — no `notification` block. If a `notification` block is
 *     present, the browser displays the push itself, before our service worker ever sees it,
 *     and there is no way to attach the DISMISS action button to it. Data-only messages are
 *     handed to the service worker's onBackgroundMessage, which calls showNotification with
 *     the actions we want. This is the whole reason the SW does the rendering.
 *  2. FCM data values must be strings. Numbers/booleans are rejected at send time, so
 *     everything below is stringified explicitly.
 */

export type PushEvent =
  | 'order_created'
  | 'order_in_progress'
  | 'order_completed'
  | 'order_paid'
  | 'order_cancelled';

/** Every status change notifies. Kept as a list so the set stays one obvious thing to edit. */
const NOTIFIED_EVENTS: PushEvent[] = [
  'order_created',
  'order_in_progress',
  'order_completed',
  'order_paid',
  'order_cancelled',
];

export function isNotifiedEvent(event: string): event is PushEvent {
  return (NOTIFIED_EVENTS as string[]).includes(event);
}

/**
 * Reduce a customer mobile to a comparable key.
 *
 * The same person is typed in as "9876543210" on one order and "+91 98765 43210" on the next,
 * and subscriptions are matched on this field — so an exact match on the raw string would
 * treat those as two different customers and silently deliver nothing. Mirrors what
 * Frontend/lib/whatsapp.ts already does to build the wa.me URL: digits only, with a 10-digit
 * number assumed to be Indian.
 *
 * Returns '' for anything that isn't a usable number, and callers treat that as "no
 * subscription possible" rather than matching every row with a blank mobile.
 */
export function normaliseMobile(raw: string | null | undefined): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  // Local formats: a leading 0 is a trunk prefix, not part of the number.
  const withoutTrunk = digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  if (withoutTrunk.length === 10) return `91${withoutTrunk}`;
  return withoutTrunk;
}

// ─── Firebase initialisation ──────────────────────────────────────────────────

let messaging: Messaging | null = null;
let initAttempted = false;

/**
 * Coax whatever ended up in FIREBASE_PRIVATE_KEY into a usable PEM.
 *
 * The value is almost always copied out of the service-account JSON, and it arrives mangled
 * in one of three ways, each of which makes `cert()` fail with the same unhelpful
 * "Failed to parse private key":
 *
 *  - It keeps the quotes it had as a JSON string value, so the PEM literally starts with `"`.
 *  - It keeps the trailing comma from the JSON object, leaving `",` on the end (which also
 *    stops dotenv recognising it as a quoted value, so the quotes survive).
 *  - Its newlines are still the two characters `\` and `n`, because most hosting dashboards
 *    (Render included) can't hold a real newline in an env var.
 *
 * All three are handled here rather than in a note telling the next person to hand-edit a
 * 1700-character PEM inside a .env file without breaking it.
 */
function normalisePrivateKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let key = raw.trim();
  key = key.replace(/,+$/, '').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, '\n');
}

/**
 * Initialised on first use rather than at boot, and *never* fatal.
 *
 * Push is an enhancement on top of an order flow that already works without it. A missing or
 * malformed service account must therefore degrade the way a missing Redis does (config/redis.ts)
 * — log once, stay off — and must never take down order creation, which is what throwing from
 * here would do given where sendOrderPush is called from.
 */
function getMessagingClient(): Messaging | null {
  if (initAttempted) return messaging;
  initAttempted = true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalisePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('[push] FIREBASE_* env vars not set — customer push notifications are disabled.');
    return null;
  }

  try {
    const app = getApps().length
      ? getApp()
      : initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    messaging = getMessaging(app);
    console.log('[push] Firebase Cloud Messaging ready');
  } catch (err: any) {
    console.warn(`[push] Firebase init failed, push disabled: ${err.message}`);
    messaging = null;
  }
  return messaging;
}

/** True when push is configured — lets routes tell a customer why opting in won't work. */
export function isPushConfigured(): boolean {
  return getMessagingClient() !== null;
}

// ─── Message copy ─────────────────────────────────────────────────────────────

interface OrderLike {
  _id: any;
  business_id: any;
  order_number: string;
  customer_name: string;
  customer_mobile: string;
  total_price?: number;
}

/**
 * Notification copy, in the same voice as the WhatsApp messages but much shorter — a push
 * body is truncated at roughly two lines on Android and one on desktop Chrome, so the order
 * number leads and nothing important trails.
 *
 * English only for now: there is no per-customer language on the order to switch on. The
 * staff-facing UI is translated (lib/translations.ts) but nothing records which language the
 * *customer* reads, so picking one here would be a guess.
 */
function buildCopy(event: PushEvent, order: OrderLike, businessName: string): { title: string; body: string } {
  const shop = businessName || 'Your laundry';
  switch (event) {
    case 'order_created':
      return { title: `Order ${order.order_number} received`, body: `${shop} has your laundry. We'll let you know as it progresses.` };
    case 'order_in_progress':
      return { title: `Order ${order.order_number} in progress`, body: `Your laundry is being worked on right now.` };
    case 'order_completed':
      return { title: `Order ${order.order_number} is ready`, body: `Your laundry is ready for pickup at ${shop}.` };
    case 'order_paid':
      return { title: `Payment received — ${order.order_number}`, body: `Thank you! Tap to view your invoice and rate your experience.` };
    case 'order_cancelled':
      return { title: `Order ${order.order_number} cancelled`, body: `Your order at ${shop} has been cancelled. We hope to see you again.` };
  }
}

// ─── Sending ──────────────────────────────────────────────────────────────────

interface SendOptions {
  /** Send to this one device only, instead of every device the customer has opted in from. */
  onlyToken?: string;
  /** Saves a lookup when the caller already has it (the notify routes do). */
  businessName?: string;
}

/**
 * Notify a customer that their order moved. Resolves to the number of devices reached.
 *
 * **Never throws.** Callers are order-write handlers, and a Firebase outage, an expired
 * service account or a network blip must not fail an order creation or a status change —
 * the customer would lose the order over a missed notification. Every failure path below
 * ends in a log line, not a rejection.
 */
export async function sendOrderPush(order: OrderLike, event: PushEvent, options: SendOptions = {}): Promise<number> {
  try {
    const fcm = getMessagingClient();
    if (!fcm) return 0;

    const mobile = normaliseMobile(order.customer_mobile);
    if (!mobile) return 0;

    const subs = options.onlyToken
      ? await PushSubscription.find({ fcm_token: options.onlyToken, revoked_at: null }).lean()
      : await PushSubscription.find({
          business_id: order.business_id,
          customer_mobile: mobile,
          revoked_at: null,
        }).lean();

    if (!subs.length) return 0;

    // Only the paid notification opens anything on tap; the rest are informational and just
    // close, so they carry no URL at all rather than one the service worker would ignore.
    let url = '';
    if (event === 'order_paid') {
      const rating = await OrderRating.findOne({ order_id: order._id }).select('rating_token').lean();
      const base = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
      if (rating?.rating_token && base) url = `${base}/rate/${rating.rating_token}`;
    }

    // Resolved here rather than at the call sites so the lookup only happens when there is
    // actually someone to notify — the common case is an order whose customer never opted
    // in, and that path should cost one indexed query in total.
    let businessName = options.businessName || '';
    if (!businessName) {
      const business = await Business.findById(order.business_id).select('name').lean();
      businessName = business?.name || '';
    }

    const { title, body } = buildCopy(event, order, businessName);

    const tokens = subs.map((s) => s.fcm_token);
    const response = await fcm.sendEachForMulticast({
      tokens,
      // Data-only. See the note at the top of this file — adding `notification` here would
      // hand rendering to the browser and lose the DISMISS button.
      data: {
        title,
        body,
        event,
        url,
        order_id: String(order._id),
        order_number: order.order_number || '',
      },
      webpush: {
        headers: {
          Urgency: 'high',
          // A phone that's off overnight should still get "ready for pickup" in the morning,
          // but a day-old status is stale enough to not be worth showing.
          TTL: '86400',
        },
        fcmOptions: url ? { link: url } : undefined,
      },
    });

    // FCM reports a token that has been uninstalled, cleared or expired as a permanent
    // failure. Left in place these accumulate forever, and every future send burns a slot on
    // a device that cannot receive it — so they're retired as soon as FCM says so.
    const dead: string[] = [];
    response.responses.forEach((r: SendResponse, i: number) => {
      const code = (r.error as any)?.code;
      if (!r.success && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-argument')) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) {
      await PushSubscription.updateMany(
        { fcm_token: { $in: dead } },
        { revoked_at: DateTime.now().toUTC().toJSDate() }
      );
    }

    return response.successCount;
  } catch (err: any) {
    console.warn(`[push] send failed for order ${order?.order_number}: ${err.message}`);
    return 0;
  }
}

/**
 * Fire-and-forget wrapper for the order routes.
 *
 * The response to the staff member must not wait on Firebase — a slow round trip would show
 * up as a slow "mark as completed" button. The promise is deliberately detached, with the
 * rejection handler present only because sendOrderPush's own catch could itself be bypassed
 * by a synchronous throw before it runs.
 */
export function sendOrderPushInBackground(order: OrderLike, event: PushEvent, options: SendOptions = {}): void {
  void sendOrderPush(order, event, options).catch(() => {});
}
