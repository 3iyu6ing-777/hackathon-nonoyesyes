/**
 * 首页 / 引导页用的插画与品牌图形，全部是内联 SVG。
 * 好处是不用等图片加载、不会因为网络问题露出空白，配色也和界面完全统一。
 */

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size * (34 / 26)}
      height={size}
      viewBox="0 0 34 26"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="mm-logo-a" x1="2" y1="2" x2="18" y2="24">
          <stop stopColor="#60a5fa" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <linearGradient id="mm-logo-b" x1="16" y1="1" x2="32" y2="23">
          <stop stopColor="#93c5fd" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <circle cx="10" cy="7.5" r="5" fill="url(#mm-logo-a)" />
      <path
        d="M1.5 23c0-4.7 3.8-8.5 8.5-8.5s8.5 3.8 8.5 8.5"
        stroke="url(#mm-logo-a)"
        strokeWidth="4.4"
        strokeLinecap="round"
      />
      <circle cx="24" cy="8.5" r="4.2" fill="url(#mm-logo-b)" opacity=".85" />
      <path
        d="M16.5 23c0-4.1 3.4-7.5 7.5-7.5s7.5 3.4 7.5 7.5"
        stroke="url(#mm-logo-b)"
        strokeWidth="3.8"
        strokeLinecap="round"
        opacity=".85"
      />
    </svg>
  );
}

/** 首页右上：一块斜放的地图，几个成员点通过虚线连到中间的推荐点 */
export function HeroMapArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 420 260" className={className} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="hm-plane" x1="70" y1="90" x2="350" y2="210">
          <stop stopColor="#fbfdff" />
          <stop offset="1" stopColor="#dfeafc" />
        </linearGradient>
        <linearGradient id="hm-road" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#cfe0f8" />
          <stop offset="1" stopColor="#b9d0f2" />
        </linearGradient>
        <linearGradient id="hm-pin-blue" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#5aa2fb" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
        <linearGradient id="hm-pin-purple" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#c084fc" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id="hm-pin-orange" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#fbbf24" />
          <stop offset="1" stopColor="#f97316" />
        </linearGradient>
        <linearGradient id="hm-pin-cyan" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#67e8f9" />
          <stop offset="1" stopColor="#0891b2" />
        </linearGradient>
        <filter id="hm-blur" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>

      <ellipse cx="212" cy="222" rx="132" ry="20" fill="#bcd3f3" opacity=".38" filter="url(#hm-blur)" />

      {/* 斜放的地图面 */}
      <path d="M60 152 190 88l170 66-130 70z" fill="url(#hm-plane)" />
      <path d="M60 152 190 88l170 66-130 70z" stroke="#d5e4f9" strokeWidth="1.4" />
      {/* 绿地与水面 */}
      <path d="m96 158 44-21 34 14-30 24z" fill="#cdebd6" opacity=".9" />
      <path d="m242 128 42 17-24 13-30-12z" fill="#cfe6fb" opacity=".95" />
      {/* 路网 */}
      <path d="M106 176 150 156l38 15 32-16 46 18" stroke="url(#hm-road)" strokeWidth="5" strokeLinecap="round" />
      <path d="M160 112 190 126l-4 34" stroke="url(#hm-road)" strokeWidth="3.4" strokeLinecap="round" opacity=".85" />

      {/* 汇合路线 */}
      <path d="M104 150c22 4 34-6 56-12" stroke="#93c5fd" strokeWidth="2.4" strokeDasharray="5 6" strokeLinecap="round" />
      <path d="M296 140c-26-4-38 2-58 6" stroke="#fbbf24" strokeWidth="2.4" strokeDasharray="5 6" strokeLinecap="round" />
      <path d="M212 196v-26" stroke="#a78bfa" strokeWidth="2.4" strokeDasharray="5 6" strokeLinecap="round" />

      {/* 小树 */}
      <g opacity=".9">
        <rect x="118" y="158" width="2.6" height="8" fill="#7fb894" />
        <circle cx="119" cy="153" r="7" fill="#86c9a0" />
        <rect x="286" y="150" width="2.6" height="8" fill="#7fb894" />
        <circle cx="287" cy="145" r="6" fill="#86c9a0" />
        <rect x="248" y="176" width="2.4" height="7" fill="#7fb894" />
        <circle cx="249" cy="172" r="5.4" fill="#9ad4ae" />
      </g>

      {/* 四个成员点 + 中间推荐点 */}
      <Pin x={104} y={150} scale={0.86} fill="url(#hm-pin-cyan)" />
      <Pin x={296} y={140} scale={0.8} fill="url(#hm-pin-orange)" />
      <Pin x={212} y={196} scale={0.74} fill="url(#hm-pin-purple)" />
      <Pin x={212} y={146} scale={1.12} fill="url(#hm-pin-blue)" star />

      {/* 光斑 */}
      <circle cx="348" cy="62" r="10" fill="#dbeafe" opacity=".8" />
      <circle cx="76" cy="72" r="6" fill="#e0eaff" opacity=".9" />
      <path d="M330 100c8-6 14-4 18 0" stroke="#fbbf24" strokeWidth="2.6" strokeLinecap="round" opacity=".55" />
    </svg>
  );
}

function Pin({
  x,
  y,
  scale = 1,
  fill,
  star = false,
}: {
  x: number;
  y: number;
  scale?: number;
  fill: string;
  star?: boolean;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="0" cy="1" rx="9" ry="3" fill="#1e3a8a" opacity=".12" />
      <path
        d="M0 -30c-8.8 0-16 7-16 15.6C-16 -5-0 10-0 10s16-15 16-24.4C16-23 8.8-30 0-30z"
        fill={fill}
      />
      <circle cx="0" cy="-14.6" r="6.2" fill="#fff" />
      {star ? (
        <path
          d="M0 -18.4l1.5 3.2 3.4.5-2.5 2.4.6 3.4-3-1.6-3 1.6.6-3.4-2.5-2.4 3.4-.5z"
          fill="#2563eb"
          opacity=".85"
        />
      ) : null}
    </g>
  );
}

/** 粘贴页右上：一个对话气泡 + 一张需求清单 */
export function HeroChatArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 300 200" className={className} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="hc-bubble" x1="30" y1="60" x2="150" y2="150">
          <stop stopColor="#ffffff" />
          <stop offset="1" stopColor="#dbe8ff" />
        </linearGradient>
        <linearGradient id="hc-doc" x1="150" y1="30" x2="250" y2="160">
          <stop stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef4ff" />
        </linearGradient>
        <linearGradient id="hc-line" x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#93c5fd" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <ellipse cx="150" cy="176" rx="96" ry="14" fill="#c9dbf7" opacity=".4" />

      <g transform="rotate(-7 100 110)">
        <rect x="26" y="56" width="146" height="100" rx="26" fill="url(#hc-bubble)" stroke="#dbe7fb" />
        <path d="M56 156l-8 22 26-14z" fill="#e3edfd" />
        <circle cx="68" cy="106" r="6.5" fill="#3b82f6" opacity=".55" />
        <circle cx="94" cy="106" r="6.5" fill="#3b82f6" opacity=".75" />
        <circle cx="120" cy="106" r="6.5" fill="#3b82f6" opacity=".95" />
      </g>

      <g transform="rotate(8 210 96)">
        <rect x="152" y="26" width="128" height="146" rx="20" fill="url(#hc-doc)" stroke="#dbe7fb" />
        <path d="M240 26h20a20 20 0 0 1 20 20v26l-40-46z" fill="#eff5ff" />
        <rect x="172" y="58" width="76" height="7" rx="3.5" fill="url(#hc-line)" opacity=".9" />
        <rect x="172" y="78" width="88" height="6" rx="3" fill="#c7dbf8" />
        <rect x="172" y="94" width="66" height="6" rx="3" fill="#c7dbf8" />
        <rect x="172" y="110" width="80" height="6" rx="3" fill="#d8e6fa" />
        <g>
          <circle cx="178" cy="136" r="7" fill="#d7f0e1" />
          <path d="m175 136 2.2 2.4 4-4.6" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round" />
          <rect x="192" y="132" width="56" height="6" rx="3" fill="#d8e6fa" />
        </g>
      </g>

      <path d="M262 52c6-8 16-8 22-2M250 18v-8M286 24l6-6" stroke="#fbbf24" strokeWidth="3" strokeLinecap="round" opacity=".8" />
      <circle cx="38" cy="34" r="7" fill="#e2edff" />
    </svg>
  );
}

/** 「创建一个房间」卡片右侧：日历 + 勾 */
export function CalendarArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 140" className={className} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="ca-body" x1="30" y1="30" x2="130" y2="120">
          <stop stopColor="#ffffff" />
          <stop offset="1" stopColor="#e8f1ff" />
        </linearGradient>
      </defs>
      <ellipse cx="84" cy="124" rx="52" ry="9" fill="#c9dbf7" opacity=".38" />
      <g transform="rotate(-9 80 76)">
        <rect x="28" y="36" width="104" height="86" rx="16" fill="url(#ca-body)" stroke="#d9e6fa" />
        <rect x="28" y="36" width="104" height="24" rx="16" fill="#bfd8fb" />
        <rect x="28" y="48" width="104" height="12" fill="#bfd8fb" />
        <rect x="48" y="26" width="9" height="20" rx="4.5" fill="#7fb0f0" />
        <rect x="103" y="26" width="9" height="20" rx="4.5" fill="#7fb0f0" />
        <g fill="#cfe2fb">
          <rect x="44" y="70" width="14" height="12" rx="4" />
          <rect x="66" y="70" width="14" height="12" rx="4" />
          <rect x="88" y="70" width="14" height="12" rx="4" />
          <rect x="44" y="90" width="14" height="12" rx="4" />
          <rect x="66" y="90" width="14" height="12" rx="4" />
        </g>
        <rect x="88" y="90" width="14" height="12" rx="4" fill="#3b82f6" opacity=".5" />
      </g>
      <circle cx="120" cy="106" r="18" fill="#34d399" />
      <path d="m112 106 5.6 5.8 10-10.8" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M136 44c6-6 14-4 18 2M30 28l-6-6" stroke="#fbbf24" strokeWidth="3.4" strokeLinecap="round" opacity=".85" />
    </svg>
  );
}

/** 「加入好友房间」卡片右侧：一小组头像 */
export function FriendsArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 170 140" className={className} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="fa-a" x1="40" y1="40" x2="120" y2="120">
          <stop stopColor="#bfdbfe" />
          <stop offset="1" stopColor="#60a5fa" />
        </linearGradient>
        <linearGradient id="fa-b" x1="40" y1="20" x2="120" y2="100">
          <stop stopColor="#dbeafe" />
          <stop offset="1" stopColor="#93c5fd" />
        </linearGradient>
      </defs>
      <ellipse cx="88" cy="124" rx="56" ry="9" fill="#c9dbf7" opacity=".38" />
      <g opacity=".85">
        <circle cx="46" cy="66" r="17" fill="url(#fa-a)" />
        <path d="M18 116c0-15 12.6-27 28-27s28 12 28 27z" fill="url(#fa-a)" />
      </g>
      <g>
        <circle cx="92" cy="52" r="21" fill="url(#fa-b)" />
        <path d="M57 116c0-19 15.6-34 35-34s35 15 35 34z" fill="url(#fa-b)" />
      </g>
      <g opacity=".6">
        <circle cx="130" cy="78" r="13" fill="#93c5fd" />
        <path d="M110 118c0-11 9-20 20-20s20 9 20 20z" fill="#93c5fd" />
      </g>
      <path d="M150 34l4-8M140 46l-7-3M156 50l7-2" stroke="#fbbf24" strokeWidth="3.2" strokeLinecap="round" opacity=".85" />
    </svg>
  );
}
