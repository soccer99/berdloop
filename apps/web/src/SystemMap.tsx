import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { useEffect } from "react";

type Pt = [number, number];

const TRUNK = 64;
const TOP = 124;
const BOTTOM = 300;
const TQ = 170; // ticket queue
const AQ = 300; // agent-task queue
const MQ = 760; // merge queue
const BRANCH = 430;
const SPINE = 470;
const LANES = [152, 212, 272];
const STAGES = [520, 590, 660];
const LANE_END = 700;
const EXIT = 850;
const RETURN = 370;
const REJOIN = 372; // the return path rejoins the agent-task queue from the right
const PICKUP = 212;

const BIRD = "M-6 -7C-1 -3 2 -1 7 0C2 1 -1 3 -6 7";

// A polyline route: even speed along every segment, heading snapped at each corner.
function route(raw: Pt[]) {
  const pts = raw.filter(
    (p, i) => i === 0 || p[0] !== raw[i - 1]![0] || p[1] !== raw[i - 1]![1],
  );
  const seg = pts
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]));
  const total = seg.reduce((a, b) => a + b, 0);
  let run = 0;
  const times = [0, ...seg.map((s) => (run += s) / total)];
  const head = seg.map(
    (_, i) =>
      (Math.atan2(pts[i + 1]![1] - pts[i]![1], pts[i + 1]![0] - pts[i]![0]) *
        180) /
      Math.PI,
  );
  const rTimes = [0];
  const rot = [head[0]!];
  for (let i = 1; i < head.length; i++) {
    rTimes.push(times[i]! - 0.0005, times[i]!);
    rot.push(head[i - 1]!, head[i]!);
  }
  rTimes.push(0.9995, 1);
  rot.push(head.at(-1)!, head[0]!);
  return {
    x: pts.map((p) => p[0]),
    y: pts.map((p) => p[1]),
    times,
    rot,
    rTimes,
  };
}

// take an agent-task -> worktree off the ticket branch -> build/test/verify
// -> merge queue -> merged and destroyed -> back for the next agent-task
function circuit(lane: number): Pt[] {
  return [
    [AQ, PICKUP],
    [SPINE, PICKUP],
    [SPINE, lane],
    [LANE_END, lane],
    [MQ, lane],
    [MQ, TOP],
    [EXIT, TOP],
    [EXIT, RETURN],
    [REJOIN, RETURN],
    [REJOIN, 260],
    [AQ, 260],
    [AQ, PICKUP],
  ];
}

function Bird({
  lane,
  duration,
  delay,
}: {
  lane: number;
  duration: number;
  delay: number;
}) {
  const r = route(circuit(lane));
  const t = { duration, repeat: Infinity, ease: "linear" as const, delay };
  return (
    <motion.g
      animate={{ x: r.x, y: r.y, rotate: r.rot }}
      transition={{
        x: { ...t, times: r.times },
        y: { ...t, times: r.times },
        rotate: { ...t, times: r.rTimes },
      }}
    >
      <motion.g
        animate={{ scaleY: [1, 0.72, 1] }}
        transition={{ duration: 0.7, repeat: Infinity, ease: "easeInOut" }}
      >
        <path d={BIRD} stroke="#111713" strokeWidth="7" strokeLinecap="round" />
        <path
          d={BIRD}
          stroke="#b8e66c"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </motion.g>
    </motion.g>
  );
}

function Queue({
  x,
  filled,
  name,
  meta,
  still,
}: {
  x: number;
  filled: number;
  name: string;
  meta: string;
  still: boolean | null;
}) {
  return (
    <g>
      <rect
        x={x - 32}
        y={TOP}
        width="64"
        height={BOTTOM - TOP}
        rx="4"
        fill="#141b15"
        stroke="#3c4a3b"
        strokeWidth="1.5"
      />
      {[0, 1, 2, 3, 4].map((i) => (
        <motion.rect
          key={i}
          x={x - 24}
          y={TOP + 8 + i * 34}
          width="48"
          height="18"
          rx="2"
          fill={i < filled ? "#b8e66c" : "#2a3a29"}
          animate={
            still || i >= filled ? undefined : { opacity: [0.4, 1, 0.4] }
          }
          transition={{ duration: 3, repeat: Infinity, delay: i * 0.5 }}
        />
      ))}
      <text x={x} y={BOTTOM + 20} textAnchor="middle">
        {name}
      </text>
      <text x={x} y={BOTTOM + 33} textAnchor="middle" className="svg-meta">
        {meta}
      </text>
    </g>
  );
}

function Stop({
  x,
  name,
  meta,
  state = "done",
}: {
  x: number;
  name: string;
  meta: string;
  state?: "done" | "active" | "pending";
}) {
  return (
    <g>
      <circle
        cx={x}
        cy={TRUNK}
        r="8"
        fill={state === "done" ? "#b8e66c" : "#111713"}
        stroke={state === "pending" ? "#6d8168" : "#b8e66c"}
        strokeWidth="2.5"
      />
      <text x={x} y={TRUNK - 20} textAnchor="middle">
        {name}
      </text>
      <text x={x} y={TRUNK - 33} textAnchor="middle" className="svg-meta">
        {meta}
      </text>
    </g>
  );
}

function Metric({
  label,
  to,
  format,
  still,
}: {
  label: string;
  to: number;
  format: (v: number) => string;
  still: boolean | null;
}) {
  const count = useMotionValue(still ? to : 0);
  const text = useTransform(count, format);
  useEffect(() => {
    if (still) return;
    const run = animate(count, to, { duration: 1.9, ease: "easeOut" });
    return () => run.stop();
  }, [count, to, still]);
  return (
    <div className="metric">
      <span>{label}</span>
      <motion.strong>{text}</motion.strong>
    </div>
  );
}

const plain = (v: number) => String(Math.round(v));

export default function SystemMap() {
  const still = useReducedMotion();
  const flow = (duration: number) => ({
    duration,
    repeat: Infinity,
    ease: "linear" as const,
  });
  return (
    <section
      className="system-map wrap"
      aria-label="How a ticket moves through Berdloop"
    >
      <div className="section-heading">
        <div className="eyebrow">
          PLANNED WORKER FLOW · TICKET QUEUE TO REVIEW
        </div>
        <h2>Build. Review. Wait to merge.</h2>
      </div>
      <div className="map-frame">
        <div className="map-label">
          ILLUSTRATIVE TICKET · BERD-1284 · 3 WORKERS
          <span>CONCEPT</span>
        </div>
        <div className="map-scroll">
          <svg viewBox="0 0 1200 420" fill="none" aria-hidden="true">
            <defs>
              <pattern
                id="mapgrid"
                width="30"
                height="30"
                patternUnits="userSpaceOnUse"
              >
                <circle cx="1" cy="1" r="1" fill="#333d31" />
              </pattern>
              <marker
                id="tip"
                markerWidth="7"
                markerHeight="7"
                refX="5"
                refY="3"
                orient="auto"
              >
                <path
                  d="M0 0l5 3-5 3"
                  fill="none"
                  stroke="#6d8168"
                  strokeWidth="1.2"
                />
              </marker>
            </defs>
            <rect width="1200" height="420" fill="url(#mapgrid)" />

            {/* ---- intake: linear -> chat ---- */}
            <path d={`M64 ${TRUNK}H1120`} stroke="#344332" strokeWidth="2" />
            <path
              d={`M${TQ} ${TRUNK + 12}V${TOP - 6}`}
              stroke="#3c4a3b"
              strokeWidth="1.5"
              markerEnd="url(#tip)"
            />

            {/* ---- ticket queue opens the ticket branch ---- */}
            <path
              d={`M${TQ + 32} 140H250V110H${BRANCH}V${TRUNK + 12}`}
              stroke="#b8e66c"
              strokeWidth="1.5"
              strokeDasharray="4 6"
              markerEnd="url(#tip)"
            />
            <text x="266" y="96" className="svg-small">
              OPENS THE TICKET BRANCH
            </text>

            {/* ---- ticket queue -> agent-task queue ---- */}
            <path
              d={`M${TQ + 32} ${PICKUP}H${AQ - 38}`}
              stroke="#3c4a3b"
              strokeWidth="1.5"
              markerEnd="url(#tip)"
            />

            {/* ---- the ticket branch trunk ---- */}
            <motion.path
              d={`M${BRANCH} ${TRUNK}H${MQ}`}
              stroke="#b8e66c"
              strokeWidth="3"
              strokeDasharray="5 9"
              animate={still ? undefined : { strokeDashoffset: [0, -28] }}
              transition={flow(1.6)}
            />
            <path
              d={`M${MQ} ${TRUNK}H1120`}
              stroke="#4d5f4a"
              strokeWidth="2"
              strokeDasharray="3 7"
            />

            {/* ---- worktrees off the ticket branch ---- */}
            <path
              d={`M${SPINE} ${TRUNK}V${LANES[2]}`}
              stroke="#344332"
              strokeWidth="2"
            />
            <text x={SPINE + 8} y={TRUNK + 26} className="svg-meta">
              WORKTREES
            </text>
            <path
              d={`M${AQ + 32} ${PICKUP}H${SPINE}`}
              stroke="#3c4a3b"
              strokeWidth="1.5"
              markerEnd="url(#tip)"
            />

            {/* ---- worker lanes ---- */}
            {LANES.map((y, i) => (
              <g key={y}>
                <path
                  d={`M${SPINE} ${y}H${LANE_END}`}
                  stroke="#3c4a3b"
                  strokeWidth="2"
                />
                <motion.path
                  d={`M${SPINE} ${y}H${LANE_END}`}
                  stroke="#b8e66c"
                  strokeWidth="2"
                  strokeDasharray="4 8"
                  opacity={0.7}
                  animate={still ? undefined : { strokeDashoffset: [0, -24] }}
                  transition={flow(1.4 + i * 0.2)}
                />
                {/* ralph loop: verify fails, build again */}
                <path
                  d={`M${STAGES[1]} ${y}C${STAGES[1]! - 18} ${y + 24} ${STAGES[0]! + 18} ${y + 24} ${STAGES[0]} ${y}`}
                  stroke="#5d7256"
                  strokeWidth="1.4"
                  strokeDasharray="3 4"
                  markerEnd="url(#tip)"
                />
                {STAGES.map((x) => (
                  <circle
                    key={x}
                    cx={x}
                    cy={y}
                    r="3.5"
                    fill="#111713"
                    stroke="#b8e66c"
                    strokeWidth="1.6"
                  />
                ))}
                <path
                  d={`M${LANE_END} ${y}H${MQ - 38}`}
                  stroke="#4d5f4a"
                  strokeWidth="1.5"
                  markerEnd="url(#tip)"
                />
                <text x={SPINE + 8} y={y - 9} className="svg-meta">
                  wt-0{i + 1}
                </text>
              </g>
            ))}
            {["BUILD", "TEST", "REVIEW"].map((s, i) => (
              <text
                key={s}
                x={STAGES[i]}
                y={LANES[0]! - 22}
                textAnchor="middle"
              >
                {s}
              </text>
            ))}
            <text
              x={(STAGES[0]! + STAGES[1]!) / 2}
              y={LANES[0]! + 38}
              textAnchor="middle"
              className="svg-small"
            >
              RALPH LOOP
            </text>

            {/* ---- merge back into the ticket branch ---- */}
            <path
              d={`M${MQ} ${TOP}V${TRUNK + 12}`}
              stroke="#b8e66c"
              strokeWidth="2"
            />
            {!still && (
              <motion.circle
                cx={MQ}
                r="4"
                fill="#b8e66c"
                animate={{ cy: [TOP, TRUNK + 12], opacity: [0, 1, 1, 0] }}
                transition={{
                  duration: 1.6,
                  repeat: Infinity,
                  repeatDelay: 1.4,
                }}
              />
            )}
            <text
              x={MQ - 14}
              y={TRUNK + 40}
              textAnchor="end"
              className="svg-small"
            >
              MERGE
            </text>

            {/* ---- merged: worktree destroyed, agent takes the next task ---- */}
            <path
              d={`M${MQ} ${TOP}H${EXIT}V${RETURN}`}
              stroke="#3c4a3b"
              strokeWidth="1.5"
              strokeDasharray="4 6"
            />
            <path
              d={`M${EXIT} ${RETURN}H${REJOIN}V260H${AQ + 34}`}
              stroke="#3c4a3b"
              strokeWidth="1.5"
              strokeDasharray="4 6"
              markerEnd="url(#tip)"
            />
            <text
              x="575"
              y={RETURN + 22}
              textAnchor="middle"
              className="svg-meta"
            >
              WORKTREE DESTROYED · AGENT TAKES THE NEXT AGENT-TASK
            </text>

            {/* ---- the three queues ---- */}
            <Queue
              x={TQ}
              filled={2}
              name="TICKET QUEUE"
              meta="FROM LINEAR"
              still={still}
            />
            <Queue
              x={AQ}
              filled={4}
              name="AGENT-TASK QUEUE"
              meta="12 PLANNED · 4 LEFT"
              still={still}
            />
            <Queue
              x={MQ}
              filled={1}
              name="MERGE QUEUE"
              meta="ONE MERGE AT A TIME"
              still={still}
            />

            {/* ---- ralph loop workers ---- */}
            {!still &&
              LANES.map((y, i) => (
                <Bird
                  key={y}
                  lane={y}
                  duration={[12, 17, 22][i]!}
                  delay={[0, -7, -15][i]!}
                />
              ))}

            {/* ---- trunk stops ---- */}
            <Stop x={64} name="LINEAR" meta="BERD-1284" />
            <Stop x={TQ} name="AGENT CHAT" meta="WRITES THE TICKETS" />
            <Stop
              x={BRANCH}
              name="TICKET BRANCH"
              meta="berd/1284"
              state="active"
            />
            <Stop
              x={880}
              name="PULL REQUEST"
              meta="OPENED ON DONE"
              state="pending"
            />
            <Stop
              x={1000}
              name="CODE REVIEW"
              meta="REVIEW AGENT"
              state="pending"
            />
            <Stop x={1120} name="MERGE" meta="AUTO / MANUAL" state="pending" />
            <text
              x="820"
              y={TRUNK + 28}
              textAnchor="middle"
              className="svg-small"
            >
              ALL AGENT-TASKS DONE
            </text>

            {/* ---- review agent findings ---- */}
            <path
              d={`M1000 ${TRUNK + 12}V146`}
              stroke="#3c4a3b"
              strokeWidth="1.5"
              markerEnd="url(#tip)"
            />
            <rect
              x="886"
              y="150"
              width="300"
              height="100"
              rx="5"
              fill="#141b15"
              stroke="#3c4a3b"
              strokeWidth="1.5"
            />
            <text x="904" y="172" className="svg-meta">
              REVIEW AGENT · 14 FILES
            </text>
            {[
              ["✓", "TESTS AND CHECKS GREEN", "#b8e66c"],
              ["✓", "NO MERGE CONFLICTS", "#b8e66c"],
              ["•", "2 SUGGESTIONS TO APPLY", "#d8f3a1"],
            ].map(([mark, copy, color], i) => (
              <g key={copy}>
                <text
                  x="904"
                  y={196 + i * 18}
                  fill={color}
                  className="svg-small"
                >
                  {mark}
                </text>
                <text x="922" y={196 + i * 18} className="svg-meta">
                  {copy}
                </text>
              </g>
            ))}
            <path
              d={`M1120 150V${TRUNK + 12}`}
              stroke="#3c4a3b"
              strokeWidth="1.5"
              markerEnd="url(#tip)"
            />
            <text x="1108" y="140" textAnchor="end" className="svg-small">
              MERGE WHEN GREEN
            </text>
          </svg>
        </div>
        <div className="route-metrics">
          <Metric label="TICKETS QUEUED" to={2} format={plain} still={still} />
          <Metric
            label="AGENT-TASKS LEFT"
            to={4}
            format={plain}
            still={still}
          />
          <Metric label="WORKERS" to={3} format={plain} still={still} />
          <Metric label="IN MERGE QUEUE" to={2} format={plain} still={still} />
        </div>
      </div>
      <p className="route-footnote">
        Planned worker execution. The current app does not run or merge agents
        yet.
      </p>
    </section>
  );
}
