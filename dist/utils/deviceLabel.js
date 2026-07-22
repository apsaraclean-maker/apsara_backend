// Lightweight User-Agent → readable device label, for showing "active devices" at the
// concurrent-session limit. Not a full UA-parsing library — just enough to distinguish
// devices in a device-limit-reached list.
export function deriveDeviceLabel(userAgent) {
    if (!userAgent)
        return 'Unknown device';
    let os = 'Unknown OS';
    if (/Windows/i.test(userAgent))
        os = 'Windows';
    else if (/Mac OS/i.test(userAgent))
        os = 'macOS';
    else if (/Android/i.test(userAgent))
        os = 'Android';
    else if (/iPhone|iPad|iOS/i.test(userAgent))
        os = 'iOS';
    else if (/Linux/i.test(userAgent))
        os = 'Linux';
    let browser = 'Unknown browser';
    if (/Edg\//i.test(userAgent))
        browser = 'Edge';
    else if (/Chrome\//i.test(userAgent))
        browser = 'Chrome';
    else if (/Firefox\//i.test(userAgent))
        browser = 'Firefox';
    else if (/Safari\//i.test(userAgent) && !/Chrome/i.test(userAgent))
        browser = 'Safari';
    const isMobile = /Mobile|Android|iPhone/i.test(userAgent);
    return `${browser} on ${os}${isMobile ? ' (Mobile)' : ''}`;
}
