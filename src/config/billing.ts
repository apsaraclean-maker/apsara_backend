/**
 * Apsara's own collection account, shown in the Billing page's "Pay Now" panel.
 *
 * This is deliberately platform-level configuration rather than a per-business field: every
 * business pays the same Apsara account, and the design (Figma node 1064:5927) shows one fixed
 * UPI handle. Env-driven so changing bank details is a config change rather than a deploy of
 * new code, with the current handle as the fallback so a machine without the vars set — every
 * developer's — still renders the panel.
 */
export const UPI_PAYEE = {
  id: process.env.APSARA_UPI_ID || 'apsaraclean@axisbank',
  name: process.env.APSARA_UPI_NAME || 'ANSHUL',
  number: process.env.APSARA_UPI_NUMBER || '7007031578',
};

/** Shown under the payment history table — sets expectations before an owner reports a
 *  payment as missing. */
export const PAYMENT_REFLECT_BUSINESS_DAYS = 3;
