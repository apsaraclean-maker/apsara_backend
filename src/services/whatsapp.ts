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
  staff_name?: string;
  phone?: string;
  pin?: string;
}

export function buildWhatsAppMessage(event: WhatsAppEvent, ctx: MessageContext): string {
  const { customer_name = '', order_number = '', business_name = '', staff_name = '', pin = '' } = ctx;

  switch (event) {
    case 'order_created':
      return `Hello ${customer_name}! 👋\n\nYour laundry order has been received.\n\n🧾 *Order ID:* ${order_number}\n🏪 *${business_name}*\n\nWe'll notify you when it's ready. Thank you for choosing us!`;

    case 'order_in_progress':
      return `Hello ${customer_name}! 🧺\n\nYour laundry order is now *in progress*.\n\n🧾 *Order ID:* ${order_number}\n\nWe're working on it and will let you know when it's done!`;

    case 'order_completed':
      return `Hello ${customer_name}! ✅\n\nYour laundry is *ready for pickup*.\n\n🧾 *Order ID:* ${order_number}\n🏪 *${business_name}*\n\nPlease collect at your convenience. Thank you!`;

    case 'order_paid':
      return `Hello ${customer_name}! 🙏\n\nPayment received for your order.\n\n🧾 *Order ID:* ${order_number}\n\nThank you for your business! We hope to see you again.`;

    case 'order_cancelled':
      return `Hello ${customer_name},\n\nYour laundry order has been *cancelled*.\n\n🧾 *Order ID:* ${order_number}\n\nIf you have any questions, please contact us. We're sorry for the inconvenience.`;

    case 'staff_created':
      return `Hello ${staff_name}! 👋\n\nWelcome to *${business_name}*!\n\nYour account has been created.\n📱 *Phone:* ${ctx.phone}\n🔑 *PIN:* ${pin}\n\nPlease keep your credentials safe.`;

    case 'staff_updated':
      return `Hello ${staff_name}!\n\nYour account details have been updated at *${business_name}*.\n\nIf you did not expect this change, please contact your manager immediately.`;

    default:
      return '';
  }
}
