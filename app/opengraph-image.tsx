import { ImageResponse } from "next/og";
import { SocialPreview } from "./social-preview";

export const alt = "Tangle — Tasks, clearly connected";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(<SocialPreview />, size);
}
