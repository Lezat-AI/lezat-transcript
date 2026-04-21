import React from "react";

// Placeholder wordmark for Lezat Transcript.
// Keeps the original component name + props so imports don't break.
// Swap in real artwork when ready.
const HandyTextLogo = ({
  width,
  height,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  const aspectViewBox = "0 0 600 120";
  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox={aspectViewBox}
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="0"
        y="85"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fontSize="96"
        fontWeight="700"
        letterSpacing="-2"
        className="logo-primary"
        fill="currentColor"
      >
        lezat<tspan fill="#F9C5E8">.</tspan>
      </text>
    </svg>
  );
};

export default HandyTextLogo;
