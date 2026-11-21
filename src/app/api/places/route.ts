import { NextResponse } from "next/server";
import { searchPlaces } from "@/lib/place";

/**
 * 返回一批候选地点，供用户手动指定某个人的出发地时挑选。
 * 自动解析只能给一个「最像的」，但地名往往有歧义（镇 / 公交站 / 小区），
 * 这里把高德的真实结果原样列出来，点哪个就是哪个。
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "请求体不是合法 JSON" },
      { status: 400 }
    );
  }

  const amapKey = (String(body.amapKey ?? "").trim() || process.env.AMAP_WEB_KEY || "").trim();
  if (!amapKey) {
    return NextResponse.json(
      { ok: false, error: "缺少高德 Web 服务 Key" },
      { status: 400 }
    );
  }

  const q = String(body.q ?? "").trim().slice(0, 40);
  if (q.length < 2) {
    return NextResponse.json(
      { ok: false, error: "地点名太短，至少 2 个字" },
      { status: 400 }
    );
  }

  const city = String(body.city ?? "杭州").trim() || "杭州";
  const items = await searchPlaces(amapKey, q, city);
  if (!items.length) {
    return NextResponse.json(
      {
        ok: false,
        error: `没搜到「${q}」`,
        detail: "换个更具体的说法，比如「文三路」「西溪印象城」",
      },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, q, items });
}
