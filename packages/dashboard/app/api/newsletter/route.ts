import { NextRequest, NextResponse } from "next/server";

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_LIST_ID = parseInt(process.env.BREVO_LIST_ID || "22", 10);

export async function POST(request: NextRequest) {
  if (!BREVO_API_KEY) {
    return NextResponse.json({ error: "Newsletter not configured" }, { status: 500 });
  }

  try {
    const { email } = await request.json();

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json({ error: "Valid email required" }, { status: 400 });
    }

    const res = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY,
      },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        listIds: [BREVO_LIST_ID],
        updateEnabled: true,
      }),
    });

    // 201 = new contact, 204 = already exists (both success)
    if (res.status === 201 || res.status === 204) {
      return NextResponse.json({ ok: true });
    }

    const err = await res.json().catch(() => ({}));
    console.error("[newsletter] Brevo error:", res.status, err);
    return NextResponse.json({ error: "Failed to subscribe" }, { status: 500 });
  } catch (err) {
    console.error("[newsletter] Error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
