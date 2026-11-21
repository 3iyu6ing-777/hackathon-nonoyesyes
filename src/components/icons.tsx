type IconName =
  | "plus"
  | "users"
  | "copy"
  | "arrow-down"
  | "arrow-right"
  | "upload"
  | "map"
  | "pin"
  | "send"
  | "check"
  | "mountain"
  | "food"
  | "dice"
  | "book"
  | "lock"
  | "ball"
  | "bag"
  | "film"
  | "gear"
  | "key"
  | "spark"
  | "home"
  | "link"
  | "search"
  | "zoom-in"
  | "zoom-out"
  | "target"
  | "layers"
  | "info"
  | "chat"
  | "phone"
  | "wallet"
  | "clock"
  | "star"
  | "close"
  | "image"
  | "file"
  | "paperclip"
  | "chevron-down"
  | "sparkles"
  | "leaf";

const PATHS: Record<IconName, string> = {
  plus: "M12 5v14M5 12h14",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  copy: "M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2M5 15H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1",
  "arrow-down": "M12 5v14M19 12l-7 7-7-7",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2M9 4v14M15 6v14",
  pin: "M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7",
  check: "M20 6 9 17l-5-5",
  mountain: "M3 20 10 6l4 8 2-3 5 9H3M14 6l2-3 2 3",
  food: "M4 3v7a3 3 0 0 0 6 0V3M7 10v11M17 3c-2 2-2 5-2 7h4V3h-2v7",
  dice: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  lock: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2M8 11V7a4 4 0 0 1 8 0v4",
  ball: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18M4 9h16M4 15h16",
  bag: "M6 7h12l1 14H5L6 7M9 7V5a3 3 0 0 1 6 0v2",
  film: "M3 4h18v16H3V4M7 4v16M17 4v16M3 10h4M3 15h4M17 10h4M17 15h4",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1",
  key: "M14.5 9.5a4.5 4.5 0 1 1-3.2-4.3M14.5 9.5 5 19v3h3l1.5-1.5V19H12l1.5-1.5",
  spark: "M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M6 6l2.4 2.4M15.6 15.6 18 18M18 6l-2.4 2.4M8.4 15.6 6 18",
  home: "M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
  link: "M10.6 13.4a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7l-1.3 1.3M13.4 10.6a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3",
  "zoom-in": "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3M11 8v6M8 11h6",
  "zoom-out": "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3M8 11h6",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2",
  layers: "M12 3 3 8l9 5 9-5-9-5M3 13l9 5 9-5M3 17.5l9 5 9-5",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5M12 8h.01",
  chat: "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l2-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2",
  wallet: "M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H5M17 13h.01",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2",
  star: "m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z",
  close: "M18 6 6 18M6 6l12 12",
  image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 8.5h.01",
  file: "M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM9 13h6M9 17h4",
  paperclip: "m21.4 11.1-9 9a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3",
  "chevron-down": "m6 9 6 6 6-6",
  sparkles: "m12 3 1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1-2.1-.9 2.1-.9zM5 3l.7 1.6L7.3 5.3 5.7 6 5 7.6 4.3 6 2.7 5.3l1.6-.7z",
  leaf: "M4 20c0-8 5-14 16-15 1 11-5 16-13 16H4M4 20c2-5 5-8 10-10",
};

export function Icon({
  name,
  size = 20,
  className = "",
  strokeWidth = 1.6,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * 活动封面：按活动类型手绘的小场景（纯 SVG）。
 * 用渐变 + 剪影做「像照片」的第一印象，不依赖任何外部图片，
 * 也不会有版权或加载失败的问题。
 */
type Scene = "hiking" | "food" | "boardgame" | "cafe" | "escape" | "sports" | "shopping" | "movie" | "other";

const SCENE_BG: Record<Scene, [string, string]> = {
  hiking: ["#cfe7d6", "#8fc9a8"],
  food: ["#ffe2cf", "#ffb894"],
  boardgame: ["#e2dcff", "#b9aaf7"],
  cafe: ["#f0e4d4", "#d3b28c"],
  escape: ["#d5dcee", "#8b9ac4"],
  sports: ["#d3ecf6", "#89cbe8"],
  shopping: ["#ffe0ea", "#f7aec6"],
  movie: ["#d9d6f2", "#9a8ee0"],
  other: ["#dbe7ff", "#a9c3f2"],
};

export function ActivityArt({
  scene,
  dim = false,
  className = "",
}: {
  scene: Scene;
  dim?: boolean;
  className?: string;
}) {
  const [from, to] = SCENE_BG[scene];
  return (
    <div
      className={`relative h-full w-full overflow-hidden ${className}`}
      style={{ background: `linear-gradient(160deg, ${from} 0%, ${to} 100%)` }}
    >
      <svg
        viewBox="0 0 160 120"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
        style={{ filter: dim ? "grayscale(0.55) opacity(0.75)" : undefined }}
      >
        {scene === "hiking" && (
          <>
            <circle cx="124" cy="26" r="13" fill="#fff" opacity=".7" />
            <path d="M0 96 36 52l26 30 18-20 30 34z" fill="#3f7a5c" opacity=".85" />
            <path d="M20 120 58 78l22 26 16-16 30 32z" fill="#244f3d" opacity=".9" />
            <path d="M0 104h160v16H0z" fill="#f6fbf7" opacity=".55" />
            <circle cx="74" cy="88" r="5" fill="#fff" opacity=".9" />
            <path d="M74 93v12M74 97l-6 5M74 97l6 5" stroke="#2f5b46" strokeWidth="2.4" strokeLinecap="round" />
          </>
        )}
        {scene === "food" && (
          <>
            <ellipse cx="80" cy="88" rx="58" ry="20" fill="#fff" opacity=".55" />
            <ellipse cx="80" cy="82" rx="46" ry="16" fill="#fff" opacity=".85" />
            <ellipse cx="80" cy="80" rx="38" ry="12" fill="#f2603c" opacity=".95" />
            <ellipse cx="80" cy="78" rx="31" ry="9" fill="#ff8a5c" />
            <path d="M52 62c4-10 12-14 18-8M80 56c3-8 9-12 14-8M104 60c4-9 10-11 14-6" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity=".75" fill="none" />
            <circle cx="66" cy="76" r="3.4" fill="#ffe6c8" />
            <circle cx="88" cy="73" r="3" fill="#ffe6c8" />
            <circle cx="99" cy="80" r="2.6" fill="#ffe6c8" />
            <path d="M60 34c6 6 14 0 20 0" stroke="#fff" strokeWidth="0" />
            <circle cx="38" cy="44" r="6" fill="#fff" opacity=".45" />
            <circle cx="126" cy="52" r="9" fill="#fff" opacity=".35" />
          </>
        )}
        {scene === "boardgame" && (
          <>
            <rect x="18" y="44" width="52" height="52" rx="10" fill="#fff" opacity=".95" transform="rotate(-8 44 70)" />
            <rect x="78" y="36" width="50" height="50" rx="10" fill="#fff" opacity=".8" transform="rotate(9 103 61)" />
            <g fill="#5b45c9">
              <circle cx="40" cy="64" r="4" /><circle cx="56" cy="76" r="4" /><circle cx="44" cy="84" r="4" />
            </g>
            <g fill="#2563eb">
              <circle cx="96" cy="52" r="4" /><circle cx="112" cy="62" r="4" /><circle cx="100" cy="72" r="4" />
            </g>
            <rect x="60" y="88" width="44" height="26" rx="6" fill="#fff" opacity=".7" transform="rotate(-12 82 101)" />
          </>
        )}
        {scene === "cafe" && (
          <>
            <rect x="0" y="88" width="160" height="32" fill="#b98f65" opacity=".55" />
            <ellipse cx="80" cy="88" rx="40" ry="9" fill="#fff" opacity=".6" />
            <path d="M56 50h44v22a18 18 0 0 1-18 18H74a18 18 0 0 1-18-18z" fill="#fff" opacity=".95" />
            <path d="M100 56h10a8 8 0 0 1 0 16h-10" stroke="#fff" strokeWidth="5" fill="none" opacity=".95" />
            <ellipse cx="78" cy="52" rx="22" ry="5" fill="#8d5f3a" opacity=".8" />
            <path d="M70 34c4-6 10-4 8 2M84 30c4-6 10-4 8 2" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" fill="none" opacity=".65" />
          </>
        )}
        {scene === "escape" && (
          <>
            <rect x="24" y="34" width="112" height="66" rx="10" fill="#2b3554" opacity=".85" />
            <rect x="44" y="52" width="72" height="48" rx="6" fill="#fff" opacity=".14" />
            <circle cx="80" cy="76" r="9" fill="#ffd36b" />
            <path d="M80 70v-6M77 76h6M80 79v4" stroke="#2b3554" strokeWidth="2.6" strokeLinecap="round" />
            <path d="M52 40h14M94 40h14" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity=".4" />
            <path d="M28 100h104" stroke="#fff" strokeWidth="3" opacity=".3" />
          </>
        )}
        {scene === "sports" && (
          <>
            <ellipse cx="80" cy="98" rx="52" ry="12" fill="#fff" opacity=".45" />
            <circle cx="80" cy="72" r="26" fill="#fff" opacity=".92" />
            <path d="M54 72h52M80 46c8 10 8 42 0 52M80 46c-8 10-8 42 0 52M58 56c14 8 30 8 44 0M58 88c14-8 30-8 44 0" stroke="#2f7fa8" strokeWidth="2.4" fill="none" opacity=".75" />
            <circle cx="120" cy="34" r="8" fill="#fff" opacity=".5" />
          </>
        )}
        {scene === "shopping" && (
          <>
            <rect x="30" y="46" width="46" height="54" rx="8" fill="#fff" opacity=".95" />
            <rect x="86" y="38" width="44" height="62" rx="8" fill="#fff" opacity=".75" />
            <path d="M41 62h24M41 72h24M41 82h16" stroke="#e58aa9" strokeWidth="3" strokeLinecap="round" />
            <path d="M96 54h24M96 66h24M96 78h14" stroke="#b6718a" strokeWidth="3" strokeLinecap="round" opacity=".7" />
            <circle cx="140" cy="30" r="10" fill="#fff" opacity=".35" />
          </>
        )}
        {scene === "movie" && (
          <>
            <rect x="20" y="40" width="120" height="58" rx="10" fill="#3b3266" opacity=".9" />
            <rect x="20" y="40" width="120" height="58" rx="10" fill="none" stroke="#fff" strokeWidth="2" opacity=".35" />
            <path d="M68 58l22 12-22 12z" fill="#fff" opacity=".92" />
            <circle cx="44" cy="26" r="9" fill="#fff" opacity=".28" />
            <circle cx="116" cy="22" r="6" fill="#fff" opacity=".2" />
            <path d="M20 104h120" stroke="#fff" strokeWidth="3" opacity=".25" />
          </>
        )}
        {scene === "other" && (
          <>
            <circle cx="34" cy="24" r="15" fill="#fff" opacity=".32" />
            <circle cx="136" cy="30" r="7" fill="#fff" opacity=".28" />
            <rect x="26" y="30" width="98" height="56" rx="14" fill="#fff" opacity=".95" />
            <path d="M50 84v15l17-15z" fill="#fff" opacity=".95" />
            <circle cx="52" cy="58" r="4.4" fill="#5b7cc4" opacity=".78" />
            <circle cx="75" cy="58" r="4.4" fill="#5b7cc4" opacity=".78" />
            <circle cx="98" cy="58" r="4.4" fill="#5b7cc4" opacity=".78" />
            <circle cx="118" cy="92" r="17" fill="#2563eb" />
            <circle cx="118" cy="92" r="17" fill="none" stroke="#fff" strokeWidth="2" opacity=".55" />
            <path d="M118 84.5v15M110.5 92h15" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
          </>
        )}
      </svg>
      {dim && <div className="absolute inset-0 bg-white/45" />}
    </div>
  );
}
