import axios from 'axios';
/**
 * Service to handle WhatsApp Business API communication
 */
export const sendWhatsAppOTP = async (phone, otp) => {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const version = process.env.WHATSAPP_VERSION || 'v20.0';
    const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'otp_verification';
    // Basic validation
    if (!token || !phoneNumberId) {
        console.warn('[WHATSAPP SERVICE] Missing configuration. OTP will not be sent via WhatsApp.');
        console.log(`[WHATSAPP MOCK] OTP for ${phone}: ${otp}`);
        return false;
    }
    // Ensure phone is in international format (remove +, spaces, etc.)
    // The API expects '919876543210' format
    const formattedPhone = phone.replace(/\D/g, '');
    try {
        const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
        // Using Template (Recommended for Business API)
        // Note: The template must be pre-approved in Meta Business Suite
        // Example template structure: "Your verification code is {{1}}."
        const response = await axios.post(url, {
            messaging_product: 'whatsapp',
            to: "91" + formattedPhone,
            type: 'template',
            template: {
                name: templateName,
                language: {
                    code: 'en_US',
                },
                components: [
                    {
                        type: 'body',
                        parameters: [
                            {
                                type: 'text',
                                text: otp,
                            },
                        ],
                    },
                    {
                        type: 'button',
                        sub_type: 'url',
                        index: '0',
                        parameters: [
                            {
                                type: 'text',
                                text: otp,
                            },
                        ],
                    },
                ],
            },
        }, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        });
        console.log('[WHATSAPP SERVICE] Message sent successfully:', response.data);
        return true;
    }
    catch (error) {
        console.error('[WHATSAPP SERVICE] Error sending message:', error.response?.data || error.message);
        // Even if it fails, we log it for the developer to see the mock OTP in dev
        console.log(`[WHATSAPP MOCK] OTP for ${phone}: ${otp}`);
        return false;
    }
};
