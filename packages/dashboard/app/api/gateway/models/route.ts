const UPSTREAM_URL = "https://ai-gateway.vercel.sh/v1/models";

export async function GET() {
  try {
    const res = await fetch(UPSTREAM_URL, {
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      return Response.json(
        { error: "Upstream request failed" },
        { status: 502 },
      );
    }

    const data = await res.json();

    return Response.json(data, {
      headers: {
        "Cache-Control":
          "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch {
    return Response.json(
      { error: "Failed to reach upstream" },
      { status: 502 },
    );
  }
}
