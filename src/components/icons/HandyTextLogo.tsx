import React from "react";

// NoteZat wordmark ("Note" in the text colour, "Zat." in sage), drawn as text
// in Barlow Bold so it follows the light and dark themes.
// Component name kept so upstream Handy imports don't need rewiring.
const HandyTextLogo = ({
  width = 120,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  // Barlow Bold "NoteZat." is about 4.1 em wide.
  const fontSize = Math.round(width / 4.1);
  return (
    <span
      role="img"
      aria-label="NoteZat"
      className={`notezat-wordmark select-none text-text ${className ?? ""}`}
      style={{ fontSize, width, display: "inline-block", textAlign: "center" }}
    >
      {"Note"}
      <span className="text-lezat-sage">{"Zat."}</span>
    </span>
  );
};

export default HandyTextLogo;
