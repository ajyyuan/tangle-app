import { ImageResponse } from "next/og";
import { IconMark } from "./icon-mark";

export const alt = "Carpaccio";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<IconMark apple color="#d84b45" />, size);
}
