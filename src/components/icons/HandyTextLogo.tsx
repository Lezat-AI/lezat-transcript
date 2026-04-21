import React from "react";
import lezatLogo from "../../assets/lezat-logo.png";

// Lezat wordmark — real logo extracted from the brand HTML invitation.
// Component name preserved so upstream Handy imports don't need rewiring.
// The source PNG is white-on-transparent and looks best against a dark
// background; upstream callers pass className with `text-white` / dark bg.
const HandyTextLogo = ({
  width,
  height,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  return (
    <img
      src={lezatLogo}
      alt="Lezat"
      width={width}
      height={height}
      className={className}
      style={{ objectFit: "contain" }}
    />
  );
};

export default HandyTextLogo;
