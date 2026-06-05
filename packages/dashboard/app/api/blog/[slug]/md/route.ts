import { getPostBySlug } from "@/lib/blog-db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  try {
    const post = await getPostBySlug(slug);
    if (!post || post.status !== "published") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const frontmatter = [
      `# ${post.seoTitle ?? post.title}`,
      "",
      `> ${post.seoDescription ?? post.excerpt}`,
      "",
      `**Author:** ${post.authorName}`,
      `**Published:** ${(post.publishedAt ?? post.createdAt).toISOString().split("T")[0]}`,
      `**Category:** ${post.category}`,
      ...(post.seoKeywords && (post.seoKeywords as string[]).length > 0
        ? [`**Keywords:** ${(post.seoKeywords as string[]).join(", ")}`]
        : []),
      "",
      "---",
      "",
    ].join("\n");

    return new Response(frontmatter + post.content, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
