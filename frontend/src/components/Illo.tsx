export type IlloKind = "bakery" | "restaurant" | "cafe" | "desserts" | "meals";

// Food illustrations from the design, used whenever a vendor has no photo.
export function Illo({ kind, size }: { kind: IlloKind; size: number }) {
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} aria-hidden="true" className="block overflow-visible">
      <ellipse cx="100" cy="192" rx="70" ry="7" fill="#2A171C" opacity="0.12" />
      {kind === "bakery" && (
        <>
          <g transform="rotate(16 112 70)">
            <rect x="98" y="8" width="28" height="112" rx="14" fill="#E0A452" />
            <path d="M104 30 l16 -6 M104 52 l16 -6 M104 74 l16 -6" stroke="#B87A2C" strokeWidth="4" strokeLinecap="round" />
          </g>
          <path d="M44 72 L156 72 L166 184 Q166 190 160 190 L40 190 Q34 190 34 184 Z" fill="#D29A5C" />
          <path d="M44 72 L156 72 L154 88 L46 88 Z" fill="#B8803F" />
          <path d="M44 72 L52 62 L60 72 L68 62 L76 72 L84 62 L92 72 L100 62 L108 72 L116 62 L124 72 L132 62 L140 72 L148 62 L156 72" fill="#D29A5C" />
          <circle cx="100" cy="132" r="22" fill="#FFF8EE" />
          <path d="M88 136 A12 12 0 0 1 112 136 Z" fill="#2A171C" />
          <g transform="translate(22 128) rotate(-14)">
            <ellipse cx="38" cy="30" rx="20" ry="26" fill="#E9A143" />
            <ellipse cx="14" cy="34" rx="15" ry="18" fill="#DE9033" />
            <ellipse cx="62" cy="34" rx="15" ry="18" fill="#DE9033" />
            <path d="M30 10 q8 20 0 42 M46 10 q-8 20 0 42" stroke="#B8701F" strokeWidth="3" fill="none" strokeLinecap="round" />
          </g>
        </>
      )}
      {kind === "restaurant" && (
        <>
          <path d="M40 104 Q100 70 160 104" fill="#F7EBCF" />
          <ellipse cx="100" cy="104" rx="62" ry="16" fill="#F7EBCF" />
          <circle cx="78" cy="96" r="4" fill="#E9B44C" />
          <circle cx="104" cy="90" r="4" fill="#E9B44C" />
          <circle cx="122" cy="98" r="4" fill="#C2410C" />
          <circle cx="92" cy="100" r="3" fill="#3F8F4E" />
          <circle cx="116" cy="92" r="3" fill="#3F8F4E" />
          <path d="M36 110 Q36 190 100 190 Q164 190 164 110 Z" fill="#8C4A2F" />
          <rect x="30" y="104" width="140" height="14" rx="7" fill="#6E3820" />
          <path d="M44 134 Q100 150 156 134" stroke="#E8C25A" strokeWidth="8" fill="none" strokeLinecap="round" />
          <circle cx="100" cy="146" r="8" fill="#E8C25A" />
        </>
      )}
      {kind === "cafe" && (
        <>
          <path d="M86 40 q-10 14 0 28 M106 34 q-10 16 0 32 M126 40 q-10 14 0 28" stroke="#2A171C" strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.35" />
          <ellipse cx="104" cy="176" rx="74" ry="14" fill="#FFFFFF" />
          <path d="M52 80 L156 80 L146 166 Q144 176 132 176 L76 176 Q64 176 62 166 Z" fill="#FFFFFF" />
          <ellipse cx="104" cy="82" rx="52" ry="10" fill="#6B3E26" />
          <path d="M154 96 q30 0 26 28 q-4 22 -32 20" stroke="#FFFFFF" strokeWidth="10" fill="none" />
          <rect x="62" y="116" width="84" height="18" rx="9" fill="#2A171C" opacity="0.9" />
          <circle cx="40" cy="168" r="26" fill="#D9A15F" />
          <circle cx="32" cy="160" r="4" fill="#5A3020" />
          <circle cx="46" cy="172" r="4" fill="#5A3020" />
          <circle cx="34" cy="178" r="3" fill="#5A3020" />
          <circle cx="50" cy="156" r="3" fill="#5A3020" />
        </>
      )}
      {kind === "desserts" && (
        <>
          <path d="M30 120 L170 92 L170 180 Q170 188 162 188 L38 188 Q30 188 30 180 Z" fill="#F7E3C6" />
          <path d="M30 120 L170 92 L170 112 L30 140 Z" fill="#E98FA9" />
          <path d="M30 152 L170 124 L170 138 L30 166 Z" fill="#E98FA9" />
          <path d="M30 120 L170 92 Q172 80 160 78 L40 100 Q26 104 30 120 Z" fill="#FFFFFF" />
          <circle cx="120" cy="72" r="14" fill="#C2243A" />
          <path d="M120 58 q4 -18 18 -22" stroke="#3F8F4E" strokeWidth="4" fill="none" strokeLinecap="round" />
        </>
      )}
      {kind === "meals" && (
        <>
          <circle cx="100" cy="116" r="78" fill="#E7E1D8" />
          <circle cx="100" cy="116" r="66" fill="#F3EFE9" />
          <circle cx="70" cy="86" r="20" fill="#C9C1B6" />
          <circle cx="70" cy="86" r="15" fill="#E9B83F" />
          <circle cx="122" cy="80" r="20" fill="#C9C1B6" />
          <circle cx="122" cy="80" r="15" fill="#D9682F" />
          <circle cx="146" cy="122" r="18" fill="#C9C1B6" />
          <circle cx="146" cy="122" r="13" fill="#FFFFFF" />
          <ellipse cx="96" cy="140" rx="34" ry="22" fill="#FFFFFF" />
          <circle cx="60" cy="136" r="22" fill="#E2B577" />
          <circle cx="56" cy="130" r="3" fill="#B8803F" />
          <circle cx="66" cy="142" r="3" fill="#B8803F" />
          <path d="M128 150 l22 8" stroke="#3F8F4E" strokeWidth="6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function illoFor(food: string, outletCategory?: string): IlloKind {
  if (outletCategory === "restaurant" && food === "meals") return "restaurant";
  if (food === "sweets") return "desserts";
  if (food === "kitchen") return "meals";
  return food as IlloKind;
}
