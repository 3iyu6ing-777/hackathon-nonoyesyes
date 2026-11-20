type IconName =
  | "plus"
  | "users"
  | "copy"
  | "arrow-down"
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
  | "spark";

const PATHS: Record<IconName, string> = {
  plus: "M12 5v14M5 12h14",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  copy: "M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2M5 15H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1",
  "arrow-down": "M12 5v14M19 12l-7 7-7-7",
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

export function ActivityArt({
  icon,
  tint,
  dim = false,
}: {
  icon: IconName;
  tint: string;
  dim?: boolean;
}) {
  return (
    <div
      className="relative h-40 w-full overflow-hidden rounded-t-2xl"
      style={{
        background: `radial-gradient(120% 100% at 30% 0%, ${tint} 0%, #131316 78%)`,
        filter: dim ? "grayscale(0.7)" : undefined,
      }}
    >
      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <pattern id={`g-${icon}`} width="28" height="28" patternUnits="userSpaceOnUse">
            <path d="M28 0H0v28" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#g-${icon})`} />
      </svg>
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ color: dim ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.62)" }}
      >
        <Icon name={icon} size={56} strokeWidth={1.1} />
      </div>
    </div>
  );
}
