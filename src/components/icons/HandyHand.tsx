// Lezat ring mark for the General sidebar tab.
// Matches the wordmark/favicon extracted from the Lezat brand assets.
// Kept the file + export name as HandyHand so upstream imports don't break.
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
    className="stroke-current fill-none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="8.5" strokeWidth="2.5" />
  </svg>
);

export default HandyHand;
