/**
 * 口语地名 → 真实坐标。
 *
 * 为什么不用地理编码：`/v3/geocode/geo` 是给「省市区+门牌号」用的。
 * 实测「转塘」「良渚」直接返回空，「钱江新城」被解析到拱墅区的
 * 「浙江钱江西湖新城」（偏离真实位置 5 公里以上），「西溪」被解析到西溪路东段。
 * 而同一批说法走 `/v3/place/text`（POI 检索）都能命中真实地名点。
 *
 * 所以这里的顺序是：
 *   1) POI 文本检索 + 名称相似度打分（能识别「这是不是一个地点」以及「像不像」）
 *   2) 地理编码兜底，且要求返回地址里确实包含这个词
 *   3) 都不行就返回 null —— 老实说「没定位到」，绝不拿行政区中心凑数
 */

const TEXT_API = "https://restapi.amap.com/v3/place/text";
const GEO_API = "https://restapi.amap.com/v3/geocode/geo";

function haversineM(
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

export type Located = {
  lat: number;
  lng: number;
  /** 高德命中的地点名，可能比原话更完整（「西溪」→「西溪」，「转塘」→「转塘」） */
  name: string;
  /** 高德返回的地址，用于界面上核对「是不是这个地方」 */
  address: string;
  /** 靠什么解析出来的 */
  via: "poi" | "geocode";
};

type RawPoi = {
  name?: unknown;
  type?: unknown;
  location?: unknown;
  address?: unknown;
  adname?: unknown;
  cityname?: unknown;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseLoc(v: unknown): { lat: number; lng: number } | null {
  const s = str(v);
  if (!s.includes(",")) return null;
  const [lngRaw, latRaw] = s.split(",");
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * 去掉名字前面的城市前缀再比。
 * 「杭州城西银泰城」和「城西银泰」指的是同一处，前缀不该算成「多出来的字」。
 */
function stripCity(s: string, city: string) {
  const n = s.replace(/\s/g, "");
  const prefixes = [city, "浙江省", "浙江", "杭州市", "杭州"].filter(Boolean);
  for (const p of prefixes) {
    if (n.startsWith(p) && n.length > p.length + 1) return n.slice(p.length);
  }
  return n;
}

/**
 * 命中的地点「像不像」用户说的那个词。
 * 返回负数表示根本不该用（名字里没有这个词）。
 */
function similarity(name: string, hint: string, city: string): number {
  const n = stripCity(name, city);
  const h = stripCity(hint, city);
  if (!n || !h) return -1;

  let s: number;
  if (n === h) s = 120;
  else if (n.startsWith(h)) s = 80;
  else if (n.endsWith(h)) s = 55;
  else if (n.includes(h)) s = 40;
  else return -1;

  // 多出来的每个字都要扣分：「西溪」命中「西溪国家湿地公园」只值 40-36
  s -= Math.min(60, Math.max(0, n.length - h.length) * 6);
  // 括号里的补充说明同样是噪音
  if (/[（(]/.test(name)) s -= 8;
  return s;
}

/**
 * 地点类型加权。
 * 「我住西溪」指的是西溪这一片，不是西溪湿地公园；所以地名类给高分，景点类扣分。
 * 「公司企业」也要压：一条名叫「未来科技城」的公司注册点会把整片园区带偏到萧山。
 * 但整片搜下来只有商户名对得上时（「城西银泰」→「城西银泰城」），第二遍会放宽这个惩罚。
 */
function typeBonus(type: string, lenient: boolean): number {
  if (!type) return 0;
  const biz = lenient ? -10 : -45;
  let s = 0;
  if (/地名地址信息/.test(type)) s += 45;
  if (/交通地名/.test(type)) s += 15;
  if (/热点地名/.test(type)) s += 10;
  if (/地铁站|公交车站/.test(type)) s += 25;
  if (/政府机关|乡镇级政府/.test(type)) s += 15;
  if (/产业园区|商务住宅|商务写字楼/.test(type)) s += 20;
  if (/风景名胜|公园广场/.test(type)) s -= 20;
  if (/收费站|道路附属设施/.test(type)) s -= 40;
  if (/公司企业|餐饮|购物|生活服务|汽车|金融|医疗|科教文化/.test(type)) s += biz;
  return s;
}

/** 拼一个能看懂、不重复的地址，用来让人核对「是不是这个地方」 */
function composeAddress(
  cityname: string,
  adname: string,
  address: string,
  name: string
): string {
  const addr = address.replace(/\s/g, "");
  if (!addr) return `${cityname}${adname}${name}`;
  // 「1号线;4号线」这种地址对人没用，直接用地名
  if (/\d+号线|[;；]/.test(addr) && !/[路街道]$/.test(name)) {
    return `${cityname}${adname}${name}`;
  }
  if (/^[\u4e00-\u9fa5]{2,8}(省|自治区)/.test(addr)) return address;
  const head = `${cityname}${adname}`;
  // 地址里只有一个区名，没有更细的信息，就把地名接上去
  if (addr.length < adname.length + 1) return `${head}${name}`;
  if (addr.includes(adname)) return `${cityname}${addr}`;
  return `${head}${addr}`;
}

async function fetchJson(url: URL, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { status?: string };
    return json.status === "1" ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * 高德 Web 服务 Key 有 QPS 上限。多人同时解析时（每人还可能试两个说法），
 * 一发一串并发请求就会被限流，返回空 —— 表现出来就是「某个人莫名其妙没显示」。
 * 所以在这一层做两件事：并发不超过 4 个，失败退避重试一次。
 */
const MAX_INFLIGHT = 4;
let inflight = 0;
const waiters: (() => void)[] = [];

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (inflight >= MAX_INFLIGHT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inflight += 1;
  try {
    return await run();
  } finally {
    inflight -= 1;
    waiters.shift()?.();
  }
}

async function requestAmap(url: URL) {
  return slot(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const json = await fetchJson(url);
      if (json) return json;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 260));
      }
    }
    return null;
  });
}

/**
 * 用 POI 检索找一个地名。
 *
 * 两遍：
 *   第一遍严格（只认地名/道路/车站/园区这类，商户类型重罚）
 *   第一遍什么都捞不到，第二遍放宽商户类型的惩罚
 *       ——「城西银泰」这种说法，高德库里只有「城西银泰城」这个商场，不放宽就永远找不到
 * 每一遍里 citylimit 先开（防止「三墩」被匹配到外地同名村），失败再放开。
 */
async function viaPoi(
  key: string,
  hint: string,
  city: string,
  near?: { lat: number; lng: number }
): Promise<Located | null> {
  for (const lenient of [false, true]) {
    const minScore = lenient ? 50 : 60;
    for (const limit of [true, false]) {
      const url = new URL(TEXT_API);
      url.searchParams.set("key", key.trim());
      url.searchParams.set("keywords", hint);
      if (city) {
        url.searchParams.set("city", city);
        if (limit) url.searchParams.set("citylimit", "true");
      }
      url.searchParams.set("offset", "10");
      url.searchParams.set("page", "1");
      url.searchParams.set("extensions", "base");

      const json = (await requestAmap(url)) as { pois?: RawPoi[] } | null;
      const pois = (json?.pois ?? []).filter((p) => p && typeof p === "object");
      if (!pois.length) continue;

      const scored: {
        name: string;
        address: string;
        type: string;
        lat: number;
        lng: number;
        score: number;
      }[] = [];

      for (const p of pois) {
        const name = str(p.name);
        const pos = parseLoc(p.location);
        if (!name || !pos) continue;
        const type = str(p.type);
        const score = similarity(name, hint, city) + typeBonus(type, lenient);
        if (score < minScore) continue;
        scored.push({
          name,
          type,
          address: composeAddress(
            str(p.cityname),
            str(p.adname),
            str(p.address),
            name
          ),
          lat: pos.lat,
          lng: pos.lng,
          score,
        });
      }

      if (!scored.length) continue;
      scored.sort((a, b) => b.score - a.score);

      // 同名多条（「文三路」这条路有好几个点）：
      // 点与点挨得近就取平均（落在路中段）；散得很开说明是**一条很长的路**，
      // 取平均会落到两头都不挨的荒地上（「文一西路」就是这么偏到老余杭的），
      // 这时改取离参考点最近的那个点。
      const best = scored[0];
      const same = scored.filter(
        (x) => x.name === best.name && x.score >= best.score - 1
      );
      if (same.length > 1) {
        let spread = 0;
        for (const x of same) {
          for (const y of same) {
            spread = Math.max(spread, haversineM(x, y));
          }
        }
        if (near && spread > 1500) {
          let pick = same[0];
          let bestD = Infinity;
          for (const x of same) {
            const d = haversineM(near, x);
            if (d < bestD) {
              bestD = d;
              pick = x;
            }
          }
          return {
            lat: pick.lat,
            lng: pick.lng,
            name: pick.name,
            address: pick.address,
            via: "poi",
          };
        }
        const lat = same.reduce((a, x) => a + x.lat, 0) / same.length;
        const lng = same.reduce((a, x) => a + x.lng, 0) / same.length;
        return { lat, lng, name: best.name, address: best.address, via: "poi" };
      }

      return {
        lat: best.lat,
        lng: best.lng,
        name: best.name,
        address: best.address,
        via: "poi",
      };
    }
  }
  return null;
}

/** 地理编码兜底：返回的地址里必须真的含这个词，否则视为瞎猜 */
async function viaGeocode(
  key: string,
  hint: string,
  city: string,
  withCity: boolean
): Promise<Located | null> {
  const url = new URL(GEO_API);
  url.searchParams.set("key", key.trim());
  url.searchParams.set("address", withCity && city ? `${city}${hint}` : hint);
  if (withCity && city) url.searchParams.set("city", city);

  const json = (await requestAmap(url)) as
    | { geocodes?: { location?: unknown; formatted_address?: unknown }[] }
    | null;
  const g = json?.geocodes?.[0];
  const pos = parseLoc(g?.location);
  if (!pos) return null;

  const formatted = str(g?.formatted_address);
  const flat = formatted.replace(/\s/g, "");
  // 只在地址里确实出现这个词时才认，避免「钱江新城 → 浙江钱江西湖新城」这类错配
  if (hint.length >= 2 && !flat.includes(hint)) return null;
  if (withCity && city && !flat.includes(city)) return null;

  return { lat: pos.lat, lng: pos.lng, name: hint, address: formatted, via: "geocode" };
}

/**
 * 搜一批候选地点，让人自己挑。
 * 自动解析再准也会有歧义（「转塘」是镇、是公交站、还是直街小区），
 * 与其猜，不如把高德真实结果摆出来让用户点一下。
 */
export async function searchPlaces(
  key: string,
  q: string,
  city = "杭州",
  limit = 6
): Promise<{ name: string; address: string; lat: number; lng: number; type: string }[]> {
  const hint = q.trim();
  if (hint.length < 2 || !key.trim()) return [];

  const url = new URL(TEXT_API);
  url.searchParams.set("key", key.trim());
  url.searchParams.set("keywords", hint);
  if (city) url.searchParams.set("city", city);
  url.searchParams.set("offset", "10");
  url.searchParams.set("page", "1");
  url.searchParams.set("extensions", "base");

  const json = (await requestAmap(url)) as { pois?: RawPoi[] } | null;
  const out: {
    name: string;
    address: string;
    lat: number;
    lng: number;
    type: string;
  }[] = [];
  const seen = new Set<string>();

  for (const p of json?.pois ?? []) {
    const name = str(p.name);
    const pos = parseLoc(p.location);
    if (!name || !pos) continue;
    const tag = `${name}|${composeAddress(
      str(p.cityname),
      str(p.adname),
      str(p.address),
      name
    )}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({
      name,
      address: composeAddress(str(p.cityname), str(p.adname), str(p.address), name),
      lat: pos.lat,
      lng: pos.lng,
      type: str(p.type),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 把一个口语地名解析成坐标。
 * 全部手段都失败时返回 null，调用方据此标「位置待确认」，不做任何猜测。
 *
 * `near` 是「这一带应该在哪」的参考点（通常是城市中心或用户自己的位置）。
 * 地理编码偶尔会把「转塘」解析到 60 公里外的建德同名村，这里直接用距离兜掉。
 */
export async function locatePlace(
  key: string,
  hint: string,
  city = "杭州",
  near?: { lat: number; lng: number }
): Promise<Located | null> {
  const h = hint.trim();
  if (h.length < 2) return null;
  if (!key.trim()) return null;

  const poi = await viaPoi(key, h, city, near);
  if (poi) return poi;

  const geo =
    (await viaGeocode(key, h, city, true)) ??
    (await viaGeocode(key, h, city, false));
  if (!geo) return null;
  if (near && haversineM(near, geo) > 70_000) return null;
  return geo;
}
