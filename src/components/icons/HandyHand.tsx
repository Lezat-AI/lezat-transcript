// Lezat "L." monogram for the General sidebar tab.
// Kept the file+export name as HandyHand so upstream imports don't need rewiring.
const HandyHand = ({
  width,
  height,
}: {
  width?: number | string;
  height?: number | string;
}) => (
  <svg
    width={width || 24}
    height={height || 24}
    viewBox="0 0 24 24"
    className="fill-current"
    xmlns="http://www.w3.org/2000/svg"
  >
    <text
      x="2"
      y="18"
      fontFamily="'Inter', system-ui, -apple-system, sans-serif"
      fontSize="20"
      fontWeight="900"
      letterSpacing="-1"
    >
      L
    </text>
    <circle cx="18" cy="18" r="2" />
  </svg>
);

export default HandyHand;
