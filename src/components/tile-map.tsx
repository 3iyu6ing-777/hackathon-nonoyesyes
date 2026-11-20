"use client";

import { useEffect, useRef, useState } from "react";
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

/** 高德矢量瓦片（GCJ-02）。国内直连，无需 Key。 */
const TILE_URL =
  "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}";

/** 颜色来自数据，必须校验，避免把任意字符串插进 HTML */
function safeColor(c: string | undefined, fallback: string) {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}

function dotHtml(color: string, size: number) {
  const inner = Math.round(size * 0.55);
  const off = Math.round((size - inner) / 2);
  return `<div style="position:relative;width:${size}px;height:${size}px"><span style="position:absolute;left:${off}px;top:${off}px;width:${inner}px;height:${inner}px;border-radius:9999px;background:${color};box-shadow:0 0 0 2px rgba(10,10,11,0.85)"></span></div>`;
}

const SPOT_HTML = `<div style="position:relative;width:22px;height:22px">
  <span style="position:absolute;inset:0;border-radius:9999px;background:rgba(74,222,128,0.22)"></span>
  <span style="position:absolute;left:6px;top:6px;width:10px;height:10px;border-radius:9999px;background:#4ade80;box-shadow:0 0 0 2px rgba(10,10,11,0.85)"></span>
</div>`;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export default function TileMap({
  points,
  lines,
}: {
  points: MapPoint[];
  lines?: MapLine[];
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

        L.control.zoom({ position: "bottomright" }).addTo(map);

        // 先画路线，再落点，保证点压在线上面
        for (const line of lineData) {
          if (line.points.length < 2) continue;
          L.polyline(line.points, {
            color: safeColor(line.color, "#71717a"),
            weight: 3,
            opacity: 0.72,
            lineCap: "round",
            dashArray: line.dashed ? "6 8" : undefined,
          }).addTo(map);
        }

        const latlngs: [number, number][] = [];

        for (const p of list) {
          const isSpot = p.kind === "spot";
          const isCandidate = p.kind === "candidate";
          const isMember = p.kind === "member";
          const size = isSpot ? 22 : isCandidate ? 12 : 16;
          const half = size / 2;
          const color = isSpot
            ? "#4ade80"
            : safeColor(p.color, isCandidate ? "#a1a1aa" : "#60a5fa");
          const html = isSpot ? SPOT_HTML : dotHtml(color, size);
          const prefix = isSpot ? "推荐 · " : isCandidate ? "候选 · " : "";

          latlngs.push([p.lat, p.lng]);

          const marker = L.marker([p.lat, p.lng], {
            icon: L.divIcon({
              className: "",
              html,
              iconSize: [size, size],
              iconAnchor: [half, half],
            }),
            keyboard: false,
            zIndexOffset: isSpot ? 1000 : isCandidate ? -100 : 100,
          }).addTo(map);

          // 成员点常驻标签：光一个彩色圆点看不出「谁、从哪来」，
          // 落点错的时候用户也发现不了。带上出发地就能一眼核对。
          const label = p.sub
            ? `${escapeHtml(p.name)}<span style="opacity:.62"> · ${escapeHtml(p.sub)}</span>`
            : escapeHtml(p.name);

          marker.bindTooltip(
            `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:6px;height:6px;border-radius:9999px;background:${color};display:inline-block"></span>${prefix}${label}</span>`,
            {
              // 推荐点与成员点常驻，候选点悬停显示，避免重叠时互相遮挡
              permanent: isSpot || isMember,
              direction: "right",
              offset: [12, 0],
              className: "mm-label",
            }
          );
        }

        if (latlngs.length === 1) {
          map.setView(latlngs[0], 14);
        } else if (latlngs.length > 1) {
          map.fitBounds(L.latLngBounds(latlngs), {
            padding: [40, 40],
            maxZoom: 14,
          });
        }

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
      setReady(false);
    };
  }, [signature]);

  const hasCandidate = points.some((p) => p.kind === "candidate");
  const hasLines = lineList.length > 0;
  const memberCount = points.filter((p) => p.kind === "member").length;

  return (
    <div className="relative h-full w-full min-h-[300px]">
      <div ref={holder} className="mm-map absolute inset-0" />

      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-surface">
          <p className="text-xs text-fg-dim">地图加载中…</p>
        </div>
      )}

      {tileFailed && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-[500] rounded-lg bg-black/70 px-3 py-2 text-[11px] leading-relaxed text-amber-300 backdrop-blur">
          地图瓦片加载失败，请检查网络后刷新；标记位置仍按坐标显示。
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 z-[500] flex flex-col gap-1.5">
        <span className="w-fit rounded-full bg-black/65 px-2.5 py-0.5 text-[11px] text-green backdrop-blur">
          绿点：推荐地点
        </span>
        <span className="w-fit rounded-full bg-black/65 px-2.5 py-0.5 text-[11px] text-fg-muted backdrop-blur">
          {memberCount > 1 ? `${memberCount} 个彩点：每位成员` : "蓝点：出发位置"}
        </span>
        {hasCandidate && (
          <span className="w-fit rounded-full bg-black/65 px-2.5 py-0.5 text-[11px] text-zinc-400 backdrop-blur">
            灰点：其他候选
          </span>
        )}
        {hasLines && (
          <span className="w-fit rounded-full bg-black/65 px-2.5 py-0.5 text-[11px] text-fg-dim backdrop-blur">
            {lineList.some((l) => l.dashed)
              ? "彩线：实线打车 · 虚线地铁/公交"
              : "彩线：各人前往路线"}
          </span>
        )}
      </div>
    </div>
  );
}
