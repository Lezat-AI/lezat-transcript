// NoteZat "N." mark for the General sidebar tab.
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
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M5 19V5h2.6l6 9.2V5H16v14h-2.6l-6-9.2V19z"
      className="fill-current"
    />
    <circle cx="19.5" cy="17.5" r="1.8" className="fill-current" />
  </svg>
);

export default HandyHand;
