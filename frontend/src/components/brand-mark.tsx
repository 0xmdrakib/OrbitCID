type BrandMarkProps = {
  size?: number;
  tone?: "default" | "light";
  className?: string;
};

export function BrandMark({ size = 32, tone = "default", className }: BrandMarkProps) {
  const source = tone === "light"
    ? "/brand/orbitcid-mark-light.png"
    : "/brand/orbitcid-mark.png";

  return <img
    className={["brand-mark-image", className].filter(Boolean).join(" ")}
    src={source}
    width={size}
    height={size}
    alt=""
    aria-hidden="true"
    draggable={false}
  />;
}
