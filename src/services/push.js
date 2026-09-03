/**
 * Push provider interface. Two implementations:
 *
 *  - 'stub': logs to console, for local dev without any push setup.
 *  - 'expo': sends through Expo's push API (https://exp.host). This
 *    works with the field app (built with Expo) using no paid Apple/Google
 *    developer account - Expo's service handles the APNs/FCM translation
 *    for you. Real production APNs/FCM credentials aren't needed until
 *    you build a standalone (non-Expo-Go) release.
 *
 * IMPORTANT: payload must never contain Incident.notes or any PHI —
 * push transport isn't BAA-covered. Payload is wake-trigger + non-PHI
 * metadata only (incident type, zone, priority). The app fetches the
 * actual notes over an authenticated REST call after waking.
 */
export async function sendPush({ deviceToken, assignmentId, incidentType, zoneLabel, priority }) {
  const provider = process.env.PUSH_PROVIDER ?? 'stub';

  if (provider === 'stub') {
    console.log(
      `[push:stub] -> ${deviceToken} :: New ${priority.toUpperCase()} ${incidentType} assignment ` +
      `(${zoneLabel}) [assignment=${assignmentId}]`
    );
    return { ok: true };
  }

  if (provider === 'expo') {
    if (!deviceToken) {
      // Staff member hasn't opened the field app / granted notification
      // permission yet - not an error, just nothing to send to.
      console.warn(`[push:expo] no device token for assignment ${assignmentId}, skipping`);
      return { ok: false, skipped: true };
    }

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify({
        to: deviceToken, // an Expo push token, e.g. "ExponentPushToken[...]"
        title: `New ${priority} priority assignment`,
        body: `${incidentType} - ${zoneLabel}`,
        data: { assignmentId },
        priority: 'high',
      }),
    });

    const result = await res.json();
    // Expo's API returns 200 even for per-message errors (e.g. an
    // unregistered/expired token) - the real status is in result.data.status.
    if (result?.data?.status === 'error') {
      throw new Error(`Expo push error: ${result.data.message ?? 'unknown'}`);
    }
    if (!res.ok) {
      throw new Error(`Expo push API returned ${res.status}`);
    }
    return { ok: true };
  }

  throw new Error(`Unknown PUSH_PROVIDER: ${provider}`);
}
