import type { SensorSample } from "./types";

/** Only the motor encoder drives this diagram. The pole is deliberately a fixed illustration. */
export function Pose({ sample }: { sample?: SensorSample }) {
  const degrees = sample?.motor_deg ?? 0,
    angle = ((degrees + 180) * Math.PI) / 180;
  const cx = 280,
    cy = 164,
    px = cx + 145 * Math.cos(angle),
    py = cy + 42 * Math.sin(angle);
  return (
    <svg
      viewBox="0 0 560 370"
      className="pose"
      role="img"
      aria-label={
        sample
          ? `底座旋转角 ${degrees.toFixed(1)} 度，连杆固定示意，不跟随摆杆读数`
          : "等待编码器数据，连杆固定示意"
      }
    >
      <g
        className="pose-reference"
        fill="none"
        stroke="#dbe2e9"
        strokeWidth="1"
      >
        <ellipse cx={cx} cy={cy} rx="145" ry="42" strokeDasharray="4 5" />
        <path d="M115 164h330m-165-53v106" strokeDasharray="3 5" />
      </g>
      <text x="105" y="168" textAnchor="end" className="pose-tick">
        0°
      </text>
      <text x="280" y="104" textAnchor="middle" className="pose-tick">
        90°
      </text>
      <g data-testid="pose-chassis">
        <path
          d="M186 265l112 29 96-31-113-29z"
          fill="#e2e7ec"
          stroke="#aab6c1"
        />
        <path
          d="M186 265v9l112 29v-9m0 9l96-31v-9"
          fill="#d0d8e0"
          stroke="#aab6c1"
        />
        <g fill="#8b99a7">
          <ellipse cx="207" cy="265" rx="3" ry="1.7" />
          <ellipse cx="298" cy="287" rx="3" ry="1.7" />
          <ellipse cx="373" cy="263" rx="3" ry="1.7" />
          <ellipse cx="282" cy="242" rx="3" ry="1.7" />
        </g>
        <path
          d="M255 197v62c0 12 50 12 50 0v-62"
          fill="#b4bec8"
          stroke="#8393a2"
        />
        <ellipse
          cx="280"
          cy="197"
          rx="25"
          ry="10"
          fill="#d5dde4"
          stroke="#8393a2"
        />
        <path d="M264 211v38m8-35v39m16-39v39m8-42v38" stroke="#9cabb8" />
        <path d="M271 165v29c0 5 18 5 18 0v-29" fill="#8c9caa" />
      </g>
      <g data-testid="pose-base" data-angle={degrees.toFixed(3)}>
        <ellipse
          cx={cx}
          cy={cy + 5}
          rx="31"
          ry="12"
          fill="#a9bdd5"
          stroke="#5076a1"
        />
        <ellipse
          cx={cx}
          cy={cy}
          rx="31"
          ry="12"
          fill="#dce8f5"
          stroke="#5076a1"
        />
        <line
          x1={cx}
          y1={cy + 3}
          x2={px}
          y2={py + 3}
          stroke="#7c98b9"
          strokeWidth="18"
          strokeLinecap="round"
        />
        <line
          x1={cx}
          y1={cy - 2}
          x2={px}
          y2={py - 2}
          stroke="#b5cbe4"
          strokeWidth="14"
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy - 2} r="4" fill="#58799c" />
        <rect
          x={px - 10}
          y={py - 12}
          width="20"
          height="29"
          rx="2"
          fill="#b8c5d2"
          stroke="#75899c"
        />
      </g>
      <g
        data-testid="pose-pole"
        data-mode="fixed"
        transform={`translate(${px},${py})`}
      >
        <line
          x1="0"
          y1="0"
          x2="0"
          y2="119"
          stroke="#8d99a4"
          strokeWidth="8"
          strokeLinecap="round"
        />
        <rect
          x="-12"
          y="91"
          width="24"
          height="20"
          rx="2"
          fill="#778795"
          stroke="#60717f"
        />
        <path d="M-7 92v18m14-18v18" stroke="#b9c3cc" />
        <circle r="8" fill="#e6ebef" stroke="#778b9e" />
        <circle r="2.5" fill="#778b9e" />
      </g>
    </svg>
  );
}
