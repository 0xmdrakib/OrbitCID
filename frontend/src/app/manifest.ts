import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OrbitCID",
    short_name: "OrbitCID",
    description: "A secure control surface for self-hosted IPFS infrastructure.",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f0ee",
    theme_color: "#141413",
    icons: [
      { src: "/brand/orbitcid-mark-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/orbitcid-mark.png", sizes: "512x512", type: "image/png" }
    ]
  };
}
