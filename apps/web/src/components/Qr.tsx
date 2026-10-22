import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * Renders a QR code as inline SVG rects (no innerHTML, no canvas, no network): the otpauth secret never leaves the page.
 * Error correction M is what authenticator apps expect for otpauth URIs.
 */
export function Qr({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { count: n + 8, path: d };
  }, [value]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${count} ${count}`} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <rect width={count} height={count} fill="#ffffff" />
      <path d={path} fill="#0b1020" />
    </svg>
  );
}
