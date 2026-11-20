import { NextResponse } from "next/server";
import { locatePlace } from "@/lib/place";

/**
 * 把用户输入的地点名解析成坐标，用于手动修正某个成员的出发点。
 * 走的是和群聊自动识别同一套解析（POI 检索优先），所以
 * 「转塘」「良渚」这类口语地名一样能定位到。
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "请求体不是合法 JSON" },
      { status: 400 }
    );
  }

  const amapKey = String(
    body.amapKey ?? process.env.AMAP_WEB_KEY ?? ""
  ).trim();
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
  // 参考点：一条很长的路（文一西路）有几十个同名点，得知道「这一带」在哪，
  // 才不会把「我住文一西路」定位到 20 公里外的另一头。
  const near =
    Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng))
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : city === "杭州"
        ? { lat: 30.2741, lng: 120.1551 }
        : undefined;
  const hit = await locatePlace(amapKey, q, city, near);
  if (!hit) {
    return NextResponse.json(
      {
        ok: false,
        error: `没能解析「${q}」的位置`,
        detail: "换个更具体的说法，比如「文三路」「西溪印象城」",
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    name: q,
    matched: hit.name,
    formatted: hit.address,
    lat: hit.lat,
    lng: hit.lng,
    via: hit.via,
  });
}
