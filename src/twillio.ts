import twilio from 'twilio';

/**
 * Service to handle WhatsApp communication using Twilio
 */
export const sendTwilioWhatsAppOTP = async (phone: string, otp: string) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromWhatsAppNumber = process.env.TWILIO_WHATSAPP_FROM_NUMBER; // Usually 'whatsapp:+14155238886' for sandbox

  // Basic validation
  if (!accountSid || !authToken || !fromWhatsAppNumber) {
    console.warn('[TWILIO SERVICE] Missing configuration. OTP will not be sent via Twilio WhatsApp.');
    console.log(`[TWILIO MOCK] OTP for ${phone}: ${otp}`);
    return false;
  }

  // Ensure phone is in simplified format for display but Twilio expects E.164
  // If phone doesn't start with '+', assume it needs international prefix (defaulting to +91 for India if not provided, or better, expect user to provide)
  let formattedPhone = phone.replace(/\D/g, '');
  if (!phone.startsWith('+')) {
    // If it's 10 digits, prefix with +91 (India)
    if (formattedPhone.length === 10) {
      formattedPhone = '+91' + formattedPhone;
    } else {
      formattedPhone = '+' + formattedPhone;
    }
  } else {
    formattedPhone = '+' + formattedPhone;
  }
console.log(formattedPhone);

  const client = twilio(accountSid, authToken);

  try {
    const message = await client.messages.create({
      body: `Your verification code for Apsara is: ${otp}. Do not share this with anyone.`,
      from:'whatsapp:'+ fromWhatsAppNumber,
      to: `whatsapp:${formattedPhone}`
    });

    console.log('[TWILIO SERVICE] Message sent successfully:', message.sid);
    return true;
  } catch (error: any) {
    console.error('[TWILIO SERVICE] Error sending message:', error.message);
    // Log for developer in case of failure
    console.log(`[TWILIO MOCK] OTP for ${phone}: ${otp}`);
    return false;
  }
};
