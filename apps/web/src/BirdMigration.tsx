import { motion, useReducedMotion } from "motion/react";

// V-formation flocks crossing the page: the loop, migrating from branch to deploy.
const FLOCKS = [
  { top: "9%", size: 1, count: 7, duration: 38, delay: -6, opacity: 0.5 },
  { top: "34%", size: 0.62, count: 5, duration: 52, delay: -31, opacity: 0.3 },
  { top: "58%", size: 1.3, count: 9, duration: 29, delay: -13, opacity: 0.62 },
  { top: "82%", size: 0.85, count: 6, duration: 44, delay: -38, opacity: 0.38 },
];

// Leader first, then alternating wings trailing behind it.
function formation(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const rank = Math.ceil(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    return { x: -rank * 30, y: side * rank * 17, lead: i === 0 };
  });
}

export default function BirdMigration() {
  const still = useReducedMotion();
  return (
    <div className="migration" aria-hidden="true">
      {FLOCKS.map((flock, f) => (
        <motion.div
          key={f}
          className="flock"
          style={{ top: flock.top, opacity: flock.opacity }}
          animate={
            still ? undefined : { x: ["-25vw", "125vw"], y: [0, -26, 14, 0] }
          }
          transition={{
            x: {
              duration: flock.duration,
              delay: flock.delay,
              repeat: Infinity,
              ease: "linear",
            },
            y: {
              duration: flock.duration / 3,
              repeat: Infinity,
              ease: "easeInOut",
            },
          }}
        >
          {formation(flock.count).map((bird, i) => (
            <motion.svg
              key={i}
              className={bird.lead ? "bird lead" : "bird"}
              width={20 * flock.size}
              height={9 * flock.size}
              viewBox="0 0 20 9"
              fill="none"
              style={{ left: bird.x * flock.size, top: bird.y * flock.size }}
              animate={still ? undefined : { scaleY: [1, 0.35, 1] }}
              transition={{
                duration: 0.85 + i * 0.06,
                delay: i * 0.12,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            >
              <path
                d="M1 7C4.5 7 5.5 2 10 2s5.5 5 9 5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </motion.svg>
          ))}
        </motion.div>
      ))}
    </div>
  );
}
