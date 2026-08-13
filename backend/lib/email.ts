// Transactional email, over Resend's REST API with plain fetch rather than a
// SDK. One endpoint and a bearer token do not justify a dependency, and
// staying on fetch means this runs unchanged on any runtime.
//
// The important behaviour here is what happens when email is NOT configured,
// which is the state this project is in until a domain is verified with a
// provider. Sending is optional: if the key is missing, nothing is sent, the
// link is logged instead, and every caller carries on. That matters because
// the alternative is a site where nobody can create an account until an
// unrelated DNS record exists somewhere.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  /// Plain text only. These are short operational messages with one link in
  /// them, and a text body renders identically everywhere, never lands in a
  /// spam folder for having a tracking pixel, and cannot break in a client
  /// that blocks remote content.
  body: string;
}

/// Returns whether the message was actually handed to a provider. Callers
/// must not treat `false` as an error: it is the expected answer when email
/// isn't set up, and the flows are written to stay usable in that state.
export async function sendEmail(message: OutgoingEmail): Promise<boolean> {
  if (!isEmailConfigured()) {
    // Development and pre-provider production both land here. Logging the
    // body means a verification link is still reachable from the function
    // logs rather than lost.
    console.info("[email not configured] would send:", message.subject, "to", message.to);
    console.info(message.body);
    return false;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.body,
      }),
      // A slow provider must not hold a signup request open indefinitely.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("email send failed", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    // Swallowed on purpose. A signup that succeeded should not be reported as
    // a failure because the mail provider had a bad minute; the account
    // exists, and verification can be re-requested.
    console.error("email send threw", err);
    return false;
  }
}

export function verificationEmail(baseUrl: string, token: string): Omit<OutgoingEmail, "to"> {
  return {
    subject: "Confirm your GPU Cert email",
    body: [
      "Confirm this address to finish setting up your GPU Cert account:",
      "",
      `${baseUrl}/verify-email?token=${token}`,
      "",
      "The link is good for 24 hours.",
      "",
      "If you did not create this account, ignore this email. Nothing was set up in your name.",
    ].join("\n"),
  };
}

export function passwordResetEmail(baseUrl: string, token: string): Omit<OutgoingEmail, "to"> {
  return {
    subject: "Reset your GPU Cert password",
    body: [
      "Use this link to choose a new password:",
      "",
      `${baseUrl}/reset-password?token=${token}`,
      "",
      "The link is good for one hour and works once.",
      "",
      "If you did not ask for this, ignore this email. Your password has not changed.",
    ].join("\n"),
  };
}
