"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

/** 注意：MapPoint / MapLine 的经纬度必须是 GCJ-02（高德坐标系），与瓦片一致。 */
export type MapPoint = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: "spot" | "member" | "candidate";
  /** 成员点的颜色，不传则按 kind 取默认色 */
  color?: string;
  /** 成员点的出发地，常驻显示在名字后面，方便一眼核对「这个人落点对不对」 */
  sub?: string;
};

export type MapLine = {
  id: string;
  color: string;
  /** [lat, lng] 序列 */
  points: [number, number][];
  dashed?: boolean;
};

/** 给外面的工具条用的地图操作 */
export type MapApi = {
  zoomIn: () => void;
  zoomOut: () => void;
  fitSpot: () => void;
  fitMembers: () => void;
  fitAll: () => void;
};

/** 高德矢量瓦片（GCJ-02）。国内直连，无需 Key。 */
const TILE_URL =
  "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}";

/** 颜色来自数据，必须校验，避免把任意字符串插进 HTML */
function safeColor(c: string | undefined, fallback: string) {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}

function dotHtml(color: string, size: number) {
  const inner = Math.round(size * 0.58);
  const off = Math.round((size - inner) / 2);
  return `<div style="position:relative;width:${size}px;height:${size}px"><span style="position:absolute;left:${off}px;top:${off}px;width:${inner}px;height:${inner}px;border-radius:9999px;background:${color};box-shadow:0 0 0 2.5px #ffffff, 0 2px 6px rgba(15,23,42,0.35)"></span></div>`;
}

const SPOT_HTML = `<div style="position:relative;width:32px;height:40px">
  <span style="position:absolute;left:8px;bottom:0;width:16px;height:5px;border-radius:9999px;background:rgba(15,23,42,0.18);filter:blur(1px)"></span>
  <svg width="32" height="40" viewBox="0 0 32 40" fill="none" style="position:absolute;left:0;top:0">
    <path d="M16 39S29 25.4 29 15.6C29 8.1 23.2 2 16 2S3 8.1 3 15.6C3 25.4 16 39 16 39z" fill="#2563eb"/>
    <path d="M16 39S29 25.4 29 15.6C29 8.1 23.2 2 16 2S3 8.1 3 15.6C3 25.4 16 39 16 39z" stroke="#ffffff" stroke-width="2.4"/>
    <circle cx="16" cy="15.4" r="5.4" fill="#ffffff"/>
  </svg>
</div>`;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function boundsOf(pts: [number, number][]) {
  let minLat = pts[0][0];
  let maxLat = pts[0][0];
  let minLng = pts[0][1];
  let maxLng = pts[0][1];
  for (const [lat, lng] of pts) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return [
    [minLat, minLng],
    [maxLat, maxLng],
  ] as [[number, number], [number, number]];
}

export default function TileMap({
  points,
  lines,
  apiRef,
}: {
  points: MapPoint[];
  lines?: MapLine[];
  apiRef?: RefObject<MapApi | null>;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [tileFailed, setTileFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const lineList = lines ?? [];
  const lineSig = lineList
    .map((l) => `${l.id}:${l.points.length}:${l.points[0]?.join(",") ?? ""}`)
    .join("|");

  // 只有点集/线集发生变化才重建地图，避免无关重渲染打断用户拖拽
  const signature =
    points.map((p) => `${p.id}:${p.lat}:${p.lng}:${p.color ?? ""}`).join("|") +
    "##" +
    lineSig;

  const pointsRef = useRef(points);
  const linesRef = useRef(lineList);

  useEffect(() => {
    pointsRef.current = points;
    linesRef.current = lineList;
  });

  useEffect(() => {
    let cancelled = false;
    const list = pointsRef.current;
    const lineData = linesRef.current;

    (async () => {
      try {
        const mod = await import("leaflet");
        const L = mod.default;
        if (cancelled || !holder.current) return;

        const map = L.map(holder.current, {
          center: [30.25, 120.09],
          zoom: 13,
          zoomControl: false,
          scrollWheelZoom: true,
          doubleClickZoom: true,
          touchZoom: true,
          dragging: true,
          zoomSnap: 1,
          attributionControl: true,
        });

        const tiles = L.tileLayer(TILE_URL, {
          subdomains: ["1", "2", "3", "4"],
          minZoom: 3,
          maxZoom: 18,
          attribution: "© 高德地图",
        });
        let errors = 0;
        tiles.on("tileerror", () => {
          errors += 1;
          if (errors >= 8) setTileFailed(true);
        });
        tiles.addTo(map);

        // 先画路线，再落点，保证点压在线上面
        for (const line of lineData) {
          if (line.points.length < 2) continue;
          L.polyline(line.points, {
            color: safeColor(line.color, "#7c8aa5"),
            weight: 3,
            opacity: 0.8,
            lineCap: "round",
            dashArray: line.dashed ? "7 9" : undefined,
          }).addTo(map);
        }

        const all: [number, number][] = [];
        const members: [number, number][] = [];
        const spots: [number, number][] = [];

        for (const p of list) {
          const isSpot = p.kind === "spot";
          const isCandidate = p.kind === "candidate";
          const size = isCandidate ? 13 : 16;
          const color = isSpot
            ? "#2563eb"
            : safeColor(p.color, isCandidate ? "#a8b6cc" : "#3b82f6");

          all.push([p.lat, p.lng]);
          if (isSpot) spots.push([p.lat, p.lng]);
          if (p.kind === "member") members.push([p.lat, p.lng]);

          const icon = isSpot
            ? L.divIcon({
                className: "",
                html: SPOT_HTML,
                iconSize: [32, 40],
                iconAnchor: [16, 39],
              })
            : L.divIcon({
                className: "",
                html: dotHtml(color, size),
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
              });

          const marker = L.marker([p.lat, p.lng], {
            icon,
            keyboard: false,
            zIndexOffset: isSpot ? 1000 : isCandidate ? -100 : 100,
          }).addTo(map);

          // 成员点常驻标签：光一个彩色圆点看不出「谁、从哪来」，
          // 落点错的时候用户也发现不了。带上出发地就能一眼核对。
          const label = p.sub
            ? `${escapeHtml(p.name)}<span style="opacity:.6"> · ${escapeHtml(p.sub)}</span>`
            : escapeHtml(p.name);

          marker.bindTooltip(
            `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:6px;height:6px;border-radius:9999px;background:${color};display:inline-block"></span>${isSpot ? "推荐 · " : isCandidate ? "候选 · " : ""}${label}</span>`,
            {
              // 推荐点与成员点常驻，候选点悬停显示，避免重叠时互相遮挡
              permanent: isSpot || p.kind === "member",
              direction: isSpot ? "right" : "right",
              offset: isSpot ? [18, -14] : [12, 0],
              className: "mm-label",
            }
          );
        }

        const fit = (pts: [number, number][], maxZoom = 15) => {
          if (cancelled) return;
          if (pts.length === 1) map.setView(pts[0], Math.max(14, maxZoom));
          else if (pts.length > 1)
            map.fitBounds(L.latLngBounds(boundsOf(pts)), {
              padding: [46, 46],
              maxZoom,
            });
        };

        if (apiRef) {
          apiRef.current = {
            zoomIn: () => map.zoomIn(),
            zoomOut: () => map.zoomOut(),
            fitSpot: () => fit(spots.length ? spots : all, 15),
            fitMembers: () => fit(members.length ? members : all, 14),
            fitAll: () => fit(all, 14),
          };
        }

        // 首屏尽量把「所有人 + 推荐点」都放进来，别一上来就只盯着推荐点
        if (all.length) fit(all, 14);

        mapRef.current = map;
        setReady(true);
        // 容器尺寸稳定后校正一次，防止首次渲染高度为 0 导致瓦片错位
        window.setTimeout(() => {
          if (!cancelled) mapRef.current?.invalidateSize();
        }, 220);
      } catch {
        setTileFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      if (apiRef) apiRef.current = null;
      setReady(false);
    };
    // apiRef 是稳定引用，不参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (
    <div className="relative h-full w-full min-h-[220px]">
      <div ref={holder} className="mm-map absolute inset-0" />

      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#eef4fb]">
          <p className="text-[11px] text-fg-dim">地图加载中…</p>
        </div>
      )}

      {tileFailed && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-[500] rounded-lg bg-white/95 px-3 py-2 text-[11px] leading-relaxed text-amber-600 shadow-lg">
          地图瓦片加载失败，请检查网络后刷新；标记位置仍按坐标显示。
        </div>
      )}
    </div>
  );
}
