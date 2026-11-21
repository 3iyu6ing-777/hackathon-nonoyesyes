/**
 * 高德开放平台封装（Web 服务 Key）。
 *
 * 这里拿到的都是**真实数据**：真实商户、真实坐标、真实票价、真实路况耗时。
 * 上层（planner）只做取舍，不允许凭空编造地点或时间。
 *
 * 三件事：
 *   1) 地点检索 —— 支持多个锚点（成员分散在城市两头时，只搜一个人附近会漏）
 *   2) 驾车/打车 —— 批量测距，一次算出所有人的驾车耗时
 *   3) 公交地铁 —— 单人单目的地，能拿到地铁线路名、站数、票价
 */

export type AmapPoi = {
  id: string;
  name: string;
  address: string;
  type: string;
  lat: number;
  lng: number;
  /** 到「最近的那个出发锚点」的直线距离，用于粗排 */
  distance: number | null;
  cost: string;
  rating: string;
  openTime: string;
  tel: string;
};

const AMAP_BASE = "https://restapi.amap.com/v3/place";

/**
 * 把一分钟折算成多少钱，用于「时间 vs 车费」的取舍。
 * 0.6 ≈ 一小时 36 元：近距离打车划算，超过 8 公里地铁更划算，和实际出行习惯接近。
 * 想让方案更偏向「快」，把这个值调大即可。
 */
export const TIME_VALUE_PER_MIN = 0.6;

/** 高德用 [] 表示空值，需要统一成字符串 */
function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

function num(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// ── 进程内短期缓存：演示时反复改条件/改位置，没必要把同样的路再算一遍 ──
type CacheEntry = { at: number; value: unknown };
const cache = new Map<string, CacheEntry>();

function cached<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  return run().then((v) => {
    // 失败的空结果不缓存，否则一次限流会把这批查询在 5 分钟里全判死
    if (v == null) return v;
    if (cache.size > 600) cache.clear();
    cache.set(key, { at: Date.now(), value: v });
    return v;
  });
}

function coordKey(p: { lat: number; lng: number }) {
  return `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
}

type RawPoi = {
  id?: unknown;
  name?: unknown;
  address?: unknown;
  type?: unknown;
  location?: unknown;
  distance?: unknown;
  tel?: unknown;
  biz_ext?: unknown;
};

/** 高德会把「暂停营业」直接写进店名后缀，推荐一家关着的店比推荐一家远的更糟 */
const CLOSED_RE = /暂停营业|已关闭|已停业|歇业|装修中|筹备中/;

function normalize(raw: RawPoi): AmapPoi | null {
  const name = str(raw.name);
  const loc = str(raw.location);
  if (!name || !loc.includes(",")) return null;
  if (CLOSED_RE.test(name)) return null;
  const [lngRaw, latRaw] = loc.split(",");
  const lng = Number(lngRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const biz = obj(raw.biz_ext);
  const address = str(raw.address);

  return {
    id: str(raw.id) || `${lat.toFixed(5)},${lng.toFixed(5)}`,
    name,
    address: address === "[]" ? "" : address,
    type: str(raw.type),
    lat,
    lng,
    distance: num(raw.distance),
    cost: str(biz.cost),
    rating: str(biz.rating),
    openTime: str(biz.open_time) || str(biz.opentime2),
    tel: str(raw.tel),
  };
}

type AmapResponse = {
  status?: string;
  info?: string;
  infocode?: string;
  pois?: RawPoi[];
};

async function request(url: URL, timeoutMs = 12_000): Promise<AmapResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`高德接口 HTTP ${res.status}`);
    const json = (await res.json()) as AmapResponse;
    if (json.status !== "1") {
      throw new Error(`高德返回错误：${json.info ?? "未知"}（${json.infocode ?? "-"}）`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(list: AmapPoi[]): AmapPoi[] {
  const seen = new Set<string>();
  const out: AmapPoi[] = [];
  for (const poi of list) {
    if (seen.has(poi.id)) continue;
    seen.add(poi.id);
    out.push(poi);
  }
  return out;
}

/** 锚点去重：相距 400 米以内算同一个点，避免重复请求 */
function dedupeAnchors(points: { lat: number; lng: number }[]) {
  const out: { lat: number; lng: number }[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (out.some((q) => haversineM(q, p) < 400)) continue;
    out.push(p);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 多点周边检索。
 * 只按一个人所在位置搜，另一头的人会被忽略；所以这里按「成员中心点 + 每个成员」各搜一遍，
 * 再合并。返回的 distance 统一成「到最近一个锚点」的距离。
 */
export async function searchPois(
  key: string,
  opts: {
    keywords: string[];
    origin: { lat: number; lng: number };
    anchors?: { lat: number; lng: number }[];
    radius?: number;
    perKeyword?: number;
    city?: string;
    cityAdcode?: string;
  }
): Promise<{ pois: AmapPoi[]; mode: "around" | "text" | "mixed"; queries: number }> {
  const apiKey = (key ?? "").trim();
  if (!apiKey) throw new Error("缺少高德 Web 服务 Key");

  const words = opts.keywords
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!words.length) throw new Error("AI 没有给出可用的搜索关键词");

  const anchors = dedupeAnchors([opts.anchors?.[0] ?? opts.origin, ...(opts.anchors ?? []), opts.origin]);
  const radius = Math.min(Math.max(opts.radius ?? 5000, 500), 50_000);
  const perKeyword = Math.min(
    Math.max(opts.perKeyword ?? 8, 1),
    anchors.length > 1 ? 6 : 25
  );

  const build = (anchor: { lat: number; lng: number }, kw: string) => {
    const url = new URL(`${AMAP_BASE}/around`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("location", `${anchor.lng},${anchor.lat}`);
    url.searchParams.set("keywords", kw);
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("offset", String(perKeyword));
    url.searchParams.set("page", "1");
    url.searchParams.set("extensions", "all");
    url.searchParams.set("sortrule", "distance");
    return url;
  };

  const jobs = anchors.flatMap((a) => words.map((kw) => build(a, kw)));
  const results = await Promise.all(
    jobs.map((url) =>
      cached(`poi:${url.toString()}`, 3 * 60_000, () =>
        request(url).catch(() => ({ pois: [] } as AmapResponse))
      )
    )
  );

  const aroundPois = dedupe(
    results.flatMap((r) =>
      (r.pois ?? []).map(normalize).filter((p): p is AmapPoi => Boolean(p))
    )
  ).map((p) => ({
    ...p,
    distance: Math.round(
      Math.min(...anchors.map((a) => haversineM(a, { lat: p.lat, lng: p.lng })))
    ),
  }));

  let mode: "around" | "text" | "mixed" = "around";
  let extra: AmapPoi[] = [];

  if (aroundPois.length < 3) {
    const textJobs = words.map((kw) => {
      const url = new URL(`${AMAP_BASE}/text`);
      url.searchParams.set("key", apiKey);
      url.searchParams.set("keywords", kw);
      url.searchParams.set("location", `${opts.origin.lng},${opts.origin.lat}`);
      url.searchParams.set("offset", String(perKeyword));
      url.searchParams.set("page", "1");
      url.searchParams.set("extensions", "all");
      url.searchParams.set("sortrule", "distance");
      if (opts.city) url.searchParams.set("city", opts.city);
      if (opts.cityAdcode) url.searchParams.set("citylimit", "true");
      return url;
    });
    const textResults = await Promise.all(
      textJobs.map((url) =>
        cached(`poi:${url.toString()}`, 3 * 60_000, () =>
          request(url).catch(() => ({ pois: [] } as AmapResponse))
        )
      )
    );
    extra = dedupe(
      textResults.flatMap((r) =>
        (r.pois ?? []).map(normalize).filter((p): p is AmapPoi => Boolean(p))
      )
    );
    mode = aroundPois.length === 0 ? "text" : "mixed";
  }

  const merged = dedupe([...aroundPois, ...extra]).sort(
    (a, b) => (a.distance ?? 9e9) - (b.distance ?? 9e9)
  );

  return { pois: merged, mode, queries: jobs.length };
}

/** 把「文三路」「西湖区古荡」这类说法转成真实坐标 */
export async function geocode(
  key: string,
  address: string,
  city = "杭州"
): Promise<{ lat: number; lng: number; formatted: string } | null> {
  const url = new URL("https://restapi.amap.com/v3/geocode/geo");
  url.searchParams.set("key", key.trim());
  url.searchParams.set("address", address);
  url.searchParams.set("city", city);
  try {
    const json = (await request(url, 8000)) as AmapResponse & {
      geocodes?: { location?: unknown; formatted_address?: unknown }[];
    };
    const g = json.geocodes?.[0];
    const loc = str(g?.location);
    if (!loc.includes(",")) return null;
    const [lngRaw, latRaw] = loc.split(",");
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, formatted: str(g?.formatted_address) };
  } catch {
    return null;
  }
}

/**
 * 批量测距：一次请求算出多个出发点到同一个目的地的驾车路程。
 * type 0=直线 1=驾车 3=步行。
 */
export async function measureDistance(
  key: string,
  origins: { lat: number; lng: number }[],
  destination: { lat: number; lng: number },
  type: 0 | 1 | 3 = 1
): Promise<{ distanceM: number | null; durationS: number | null }[]> {
  const empty = origins.map(() => ({ distanceM: null, durationS: null }));
  if (!origins.length) return empty;

  const url = new URL("https://restapi.amap.com/v3/distance");
  url.searchParams.set("key", key.trim());
  url.searchParams.set(
    "origins",
    origins.map((o) => `${o.lng},${o.lat}`).join("|")
  );
  url.searchParams.set("destination", `${destination.lng},${destination.lat}`);
  url.searchParams.set("type", String(type));

  try {
    const json = (await cached(`dist:${url.toString()}`, 60_000, () =>
      request(url, 9000)
    )) as AmapResponse & {
      results?: { origin_id?: unknown; distance?: unknown; duration?: unknown }[];
    };
    const list = json.results ?? [];
    return origins.map((_, i) => {
      const hit =
        list.find((x) => Number(str(x.origin_id)) === i + 1) ?? list[i];
      return {
        distanceM: num(hit?.distance),
        durationS: num(hit?.duration),
      };
    });
  } catch {
    return empty;
  }
}

/** 打车费估算（杭州：起步 11 元/3km，之后约 2.5 元/km） */
export function taxiFare(distanceM: number): number {
  const km = distanceM / 1000;
  return Math.round(11 + Math.max(0, km - 3) * 2.5);
}

export type TransitResult = {
  distanceM: number;
  durationS: number;
  fareYuan: number;
  walkM: number;
  /** ["地铁3号线","地铁1号线"] 这种，按换乘顺序 */
  lines: string[];
  isMetro: boolean;
  /** 「地铁3号线 12站 → 步行 2.0km」 */
  summary: string;
  /** 折线，[lat,lng]；只要 steps=true 才有 */
  points: [number, number][];
};

type RawTransit = {
  cost?: unknown;
  duration?: unknown;
  distance?: unknown;
  walking_distance?: unknown;
  segments?: {
    walking?: { distance?: unknown; duration?: unknown; steps?: { polyline?: unknown }[] };
    bus?: {
      buslines?: {
        name?: unknown;
        type?: unknown;
        departure_stop?: { name?: unknown };
        arrival_stop?: { name?: unknown };
        via_num?: unknown;
        polyline?: unknown;
      }[];
    };
  }[];
};

/** "地铁3号线(星桥--石马)" → "地铁3号线"；"41路(×)" 这种也一并清掉 */
function cleanLine(name: string) {
  return name.split(/[（(]/)[0].replace(/[)）]/g, "").trim();
}

function pushPolyline(points: [number, number][], poly: unknown) {
  for (const seg of str(poly).split(";")) {
    const [lngRaw, latRaw] = seg.split(",");
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lat, lng]);
  }
}

/**
 * 公交 / 地铁方案。
 * 高德会一次给出好几个换乘组合，这里按「时间折算成钱 + 车费」挑最划算的那个。
 */
export async function planTransit(
  key: string,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  city = "杭州",
  steps = false
): Promise<TransitResult | null> {
  const url = new URL("https://restapi.amap.com/v3/direction/transit/integrated");
  url.searchParams.set("key", key.trim());
  url.searchParams.set("origin", `${origin.lng},${origin.lat}`);
  url.searchParams.set("destination", `${destination.lng},${destination.lat}`);
  url.searchParams.set("city", city);
  url.searchParams.set("cityd", city);
  url.searchParams.set("strategy", "0");
  url.searchParams.set("nightflag", "0");
  url.searchParams.set("extensions", steps ? "all" : "base");

  const key2 = `transit:${steps ? "a" : "b"}:${coordKey(origin)}>${coordKey(destination)}:${city}`;

  try {
    const json = (await cached(key2, 5 * 60_000, async () => {
      // 并发高时高德偶尔会掐一下，重试一次比直接放弃划算
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await request(url, 10_000);
        } catch (e) {
          if (attempt >= 1) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    })) as AmapResponse & { route?: { transits?: RawTransit[] } };
    const list = json.route?.transits ?? [];
    if (!list.length) return null;

    const scored = list
      .map((t) => {
        const durationS = num(t.duration) ?? 0;
        const fare = num(t.cost) ?? 0;
        return {
          t,
          durationS,
          fare,
          score: (durationS / 60) * TIME_VALUE_PER_MIN + fare,
        };
      })
      .filter((x) => x.durationS > 0)
      .sort((a, b) => a.score - b.score);

    const best = scored[0];
    if (!best) return null;

    const lines: string[] = [];
    let stops = 0;
    let isMetro = false;
    const points: [number, number][] = [];

    for (const seg of best.t.segments ?? []) {
      if (steps && seg.walking?.steps) {
        for (const st of seg.walking.steps) pushPolyline(points, st.polyline);
      }
      const bl = seg.bus?.buslines?.[0];
      if (!bl) continue;
      const name = cleanLine(str(bl.name));
      if (name && !lines.includes(name)) lines.push(name);
      if (str(bl.type).includes("地铁")) isMetro = true;
      stops += Number(str(bl.via_num)) || 0;
      if (steps) pushPolyline(points, bl.polyline);
    }

    const walkM = Math.round(num(best.t.walking_distance) ?? 0);
    const parts = [
      lines.length ? `${lines.join(" → ")}${stops ? ` ${stops}站` : ""}` : "公交",
      walkM > 0
        ? `步行 ${walkM >= 1000 ? `${(walkM / 1000).toFixed(1)}km` : `${walkM}m`}`
        : "",
    ].filter(Boolean);

    return {
      distanceM: num(best.t.distance) ?? 0,
      durationS: best.durationS,
      fareYuan: best.fare,
      walkM,
      lines,
      isMetro,
      summary: parts.join(" · "),
      points,
    };
  } catch {
    return null;
  }
}

/** 单个人 → 目的地的真实路线（含折线），用于在地图上画线 */
export async function planRoute(
  key: string,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: "walking" | "driving"
): Promise<{
  distanceM: number;
  durationS: number;
  points: [number, number][];
} | null> {
  const url = new URL(`https://restapi.amap.com/v3/direction/${mode}`);
  url.searchParams.set("key", key.trim());
  url.searchParams.set("origin", `${origin.lng},${origin.lat}`);
  url.searchParams.set("destination", `${destination.lng},${destination.lat}`);
  url.searchParams.set("extensions", "base");
  if (mode === "driving") url.searchParams.set("strategy", "0");

  try {
    const json = (await cached(`route:${url.toString()}`, 2 * 60_000, () =>
      request(url, 9000)
    )) as AmapResponse & {
      route?: {
        paths?: {
          distance?: unknown;
          duration?: unknown;
          steps?: { polyline?: unknown }[];
        }[];
      };
    };
    const path = json.route?.paths?.[0];
    if (!path) return null;

    const points: [number, number][] = [];
    for (const step of path.steps ?? []) pushPolyline(points, step.polyline);
    if (points.length < 2) {
      points.length = 0;
      points.push([origin.lat, origin.lng], [destination.lat, destination.lng]);
    }

    return {
      distanceM: num(path.distance) ?? 0,
      durationS: num(path.duration) ?? 0,
      points,
    };
  } catch {
    return null;
  }
}
