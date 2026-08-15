import { DateTime } from 'luxon';
import { BUSINESS_TIMEZONE } from '../utils/timezone.js';

export type WhatsAppEvent =
  | 'order_created'
  | 'order_in_progress'
  | 'order_completed'
  | 'order_paid'
  | 'order_cancelled'
  | 'staff_created'
  | 'staff_updated';

interface MessageContext {
  customer_name?: string;
  order_number?: string;
  business_name?: string;
  /** Branch the order was booked at. Printed beside the business name on the created message. */
  branch_name?: string;
  staff_name?: string;
  phone?: string;
  pin?: string;
  /** Order total, unformatted — formatted here so every message renders money identically. */
  order_total?: number;
  /** Delivery due date, unformatted. Null/absent simply drops the line. */
  due_date?: Date | string | null;
  /**
   * Absolute URL of the customer's order page (/order/<rating_token>), which lists the line
   * items and carries the "Enable Notifications" button. Omitted when PUBLIC_APP_URL isn't
   * configured, in which case the line is dropped rather than emitted as a broken link.
   */
  order_url?: string;
}

/** Matches the frontend's formatMoney (lib/format.ts) so the two never disagree on a total. */
function formatMoney(value: number): string {
  return `₹${(Number(value) || 0).toFixed(2)}`;
}

/**
 * Due dates are stored UTC but read by a customer in India, so they're rendered in the
 * business timezone — otherwise an evening due date shows as the previous day.
 */
function formatDueDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value));
  if (!dt.isValid) return '';
  return dt.setZone(BUSINESS_TIMEZONE).toFormat('d MMM yyyy');
}

export function buildWhatsAppMessage(event: WhatsAppEvent, ctx: MessageContext): string {
  const {
    customer_name = '',
    order_number = '',
    business_name = '',
    branch_name = '',
    staff_name = '',
    pin = '',
    order_total,
    due_date,
    order_url = '',
  } = ctx;

  // "Sparkle Wash Co., Nairobi" when both are known, and gracefully less when they aren't —
  // the previous template interpolated an always-empty business_name straight into `*{}*`,
  // which rendered as a bare `**` on every message a customer received.
  const shopLine = [business_name, branch_name].filter(Boolean).join(', ');

  // WhatsApp only linkifies bare URLs in a plain-text message — there is no anchor-text
  // syntax — so the label sits on its own line above the link rather than wrapping it.
  const orderDetailsLine = order_url
    ? `\n📦 *Order Details:* Click here to see full order list\n${order_url}`
    : '';
  const totalLine = order_total !== undefined ? `\n💰 *Order Total:* ${formatMoney(order_total)}` : '';
  const dueDate = formatDueDate(due_date);
  const dueLine = dueDate ? `\n📅 *Due Date:* ${dueDate}` : '';

  switch (event) {
    case 'order_created':
      return `Hello ${customer_name} 👋\nWe at ${shopLine || 'your laundry'} have received your order.\n\n🧾 *Order ID:* ${order_number}${orderDetailsLine}${totalLine}${dueLine}\n\nWe'll notify you when it's ready. Thank you for choosing us! 😄`;

    case 'order_in_progress':
      return `Hello ${customer_name} 👋\n\nYour laundry order is now *in progress*. 👕🧼\n\n🧾 *Order ID:* ${order_number}\n\nWe'll notify you when it's ready. Thank you for choosing us! 😄`;

    case 'order_completed':
      return `Hello ${customer_name} 👋\n\nYour laundry is *ready for pickup*. Please collect at your convenience. Thank you! 😄\n\n🧾 *Order ID:* ${order_number}`;

    case 'order_paid':
      return `Hello ${customer_name} 👋\n\nPayment received for your order.\n\n🧾 *Order ID:* ${order_number}\n\nWe hope to see you again! 🙏`;

    case 'order_cancelled':
      return `Hello ${customer_name} 👋\n\nWe have cancelled your order as per request.\n\n🧾 *Order ID:* ${order_number}\n\nWe hope to see you again! 🙏`;

    case 'staff_created':
      return `Hello ${staff_name}! 👋\n\nWelcome to *${business_name}*!\n\nYour account has been created.\n📱 *Phone:* ${ctx.phone}\n🔑 *PIN:* ${pin}\n\nPlease keep your credentials safe.`;

    case 'staff_updated':
      return `Hello ${staff_name}!\n\nYour account details have been updated at *${business_name}*.\n\nIf you did not expect this change, please contact your manager immediately.`;

    default:
      return '';
  }
}
